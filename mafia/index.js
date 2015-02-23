var uuid = require('node-uuid');

// Менеджер комнат
var roomManager = require('./rooms');

// Главный объект Socket.IO
var io;

// Файл конфигурации (config.json)
var config;

exports.useIO = function (_io, _config) {
  io = _io;
  config = _config;
};

// Главная функция обработки событий сокета.
// Это — единственная функция модуля игры, доступная извне (не считая функций
// рендера ниже); вся логика игры так или иначе связана с этой функцией.
exports.clientConnection = function (socket) {
  if (config.debug) {
    var clientIP;
    var forwarded = socket.request.headers['x-forwarded-for'];

    if (forwarded) {
      // Соединение через Heroku (или другую систему рутинга)
      var forwardedIPs = forwarded.split(',');
      clientIP = forwardedIPs[0];
    }
    if (!clientIP) {
      // Обычное соединение
      clientIP = socket.request.connection.remoteAddress;
    }

    console.log("[IO] Соединение с клиентом " + clientIP);
  }

  // Получение UUID (только через API)
  socket.on('getNewPlayerID', function onGetNewPlayerID() {
    socket.emit('playerIDReturned', uuid.v4());
  });

  // Кнопки главного меню
  socket.on('findRoom', function onFindRoom() {
    var roomID = roomManager.findRoomID(config.defaultOptions,
      config.newRoomTimeout);
    socket.emit('roomIDReturned', roomID);
  });
  socket.on('newRoom', function onNewRoom() {
    var roomID = roomManager.newRoomID(config.defaultOptions,
      config.newRoomTimeout);
    socket.emit('roomIDReturned', roomID);
  });

  // Подтверждение комнаты
  socket.on('ackRoom', function onAckRoom(userData) {
    var room = roomManager.rooms[userData.roomID];
    var playerID = userData.playerID;
    var playerName = 'playerName' in userData ? userData.playerName :
      config.defaultName;

    // Проверка на существование комнаты
    if (typeof room === 'undefined') {
      return;
    }

    // Подключается ли игрок в первый раз
    var isFirstConnection = false;

    // Если игрока нет в комнате
    if (!(playerID in room.clients) && room.isSealed) // и комната запечатана
    {
      // Отправляем сообщение о том, что игра уже началась
      socket.emit('roomIsSealed');
      // Прерываем обработку события
      return;
    }

    // Если игрока нет в комнате, но комната еще не запечатана
    if (!(playerID in room.clients)) {
      isFirstConnection = true;
      // Добавляем игрока в комнату
      room.connect(playerID, playerName, socket);
      // Оповещаем всех игроков о присоединении нового игрока
      socket.broadcast.to(room.id).emit('newPlayer', playerName);
    } else {
      // Изменяем сокет
      room.clients[playerID].socket = socket;
    }

    // Подключаем клиента к соответствующей комнате Socket.IO
    socket.join(room.id);

    // Отправляем игроку информацию о комнате
    var roomData = {
      // Подключается ли игрок впервые
      isFirstConnection: isFirstConnection,
      // Может ли игрок начинать игру
      canStartGame: !room.isSealed && (playerID === room.owner.id),
      // Список игроков в комнате
      playerList: room.getPlayerList()
    };

    // Если игра началась, добавляем информацию об игре
    if (room.game) {
      // Текущее состояние игры
      roomData.gameState = room.game.state;
      // Роль игрока
      roomData.playerRole = room.game.roles[playerID];
      // Выбывшие игроки
      roomData.elimPlayers = room.game.getElimPlayers();
    }

    socket.emit('roomData', roomData);
  });

  // Начало игры
  socket.on('startGame', function onStartGame(userData) {
    var room = roomManager.rooms[userData.roomID];
    if (typeof room === 'undefined') {
      return;
    }

    // Если игрок — владелец комнаты
    if (userData.playerID === room.owner.id) {
      // Запечатываем ее и начинаем игру
      room.seal();
      room.startGame(function onUpdate(data) {
        io.to(room.id).emit('update', data);
      });
      // Оповещаем всех игроков о начале игры
      io.to(room.id).emit('gameStarted');
      // Устанавливаем таймаут для неактивной комнаты
      room.setRoomTimeout(config.inactiveRoomTimeout);
    }
  });

  // Выход из игры
  socket.on('leaveGame', function onLeaveGame(userData) {
    var room = roomManager.rooms[userData.roomID];
    if (typeof room === 'undefined') {
      return;
    }

    // Здесь должен обрабатываться сигнал о выходе из игры.
  });

  // Голосование
  socket.on('playerVote', function onPlayerVote(data) {
    var room = roomManager.rooms[data.userData.roomID];
    var playerID = data.userData.playerID;

    if (typeof room === 'undefined') {
      return;
    }

    if ((playerID in room.clients) && room.game && room.game.state.isVoting) {
      var voteData = {
        playerIndex: room.ids.indexOf(playerID),
        vote: data.vote
      };

      if (room.game.state.isDay) {
        socket.broadcast.to(room.id).emit('vote', voteData);
      } else {
        if (room.game.roles[playerID] === 'mafia') {
          socket.broadcast.to(room.id + '_m').emit('vote', voteData);
        } else {
          socket.emit('voteRejected', data.voteID);
          return;
        }
      }

      // Отправляем голосование на проверку
      room.game.processVote(playerID, data.vote);

      // Не даем комнате самоликвидироваться
      room.setRoomTimeout(config.inactiveRoomTimeout);
    }

    // Обработка голосования в случае, если оно идет
    if (room.game.state.isVoting) {
      room.game.processVote(data.userData.playerID, data.vote);
      room.setRoomTimeout(config.inactiveRoomTimeout);
    }
  });

  // Сообщение чата.
  // Чат перекрывается ночью для мирных жителей.
  socket.on('chatMessage', function onChatMessage(data) {
    var room = roomManager.rooms[data.userData.roomID];
    var player = room.clients[data.userData.playerID];

    if (typeof room === 'undefined') {
      return;
    }

    if (player.id in room.clients) {
      var msgData = {
        playerName: player.playerName,
        message: data.message
      };

      if (room.game && !room.game.state.isDay) {
        // Локальный чат мафии (ночью)
        if (room.game.roles[player.id] === 'mafia') {
          socket.broadcast.to(room.id + '_m').emit('chatMessage', msgData);
          console.log("[CHAT] [" + room.id + "] [M] " + player.playerName +
            ": " + data.message);
        } else {
          if ('messageID' in data) {
            socket.emit('chatMessageRejected', data.messageID);
          }
          return;
        }
      } else {
        // Всеобщий чат (днем)
        socket.broadcast.to(room.id).emit('chatMessage', msgData);
        console.log("[CHAT] [" + room.id + "] " + player.playerName + ": " +
          data.message);
      }

      // Отправляем подтверждение
      if ('messageID' in data) {
        socket.emit('chatMessageConfirmed', data.messageID);
      }

      // В зависимости от того, начата игра или нет, выбираем таймаут
      var timeout = room.game ? config.inactiveRoomTimeout :
        config.newRoomTimeout;
      room.setRoomTimeout(timeout);
    }
  });
};

// Далее следуют функции, возвращающие клиенту отрендеренные шаблоны.
// По правде говоря, их можно было поместить в routes.js, но оставить их здесь
// показалось наиболее верным (и эстетически приятным) решением.

// Страница загрузки при поиске
exports.findRoom = function (req, res) {
  res.render('loading', {
    eventName: 'findRoom',
    message: "Идет поиск игры."
  });
};

// Страница загрузки при создании
exports.newRoom = function (req, res) {
  res.render('loading', {
    eventName: 'newRoom',
    message: "Идет создание комнаты."
  });
};

// Рендер шаблона комнаты
exports.displayRoom = function (req, res, roomID) {
  if (roomID in roomManager.rooms) {
    // Назначение пользователю уникального идентификатора
    if (!('playerID' in req.cookies)) {
      res.cookie('playerID', uuid.v4());
    }
    res.render('room', {
      roomID: roomID
    });
  } else {
    res.status(404);
    res.render('404', {
      message: "Комнаты не существует."
    });
  }
};