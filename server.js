const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }
});

const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data.json');

// ========== DATA ==========
let data = {
  users: {},       // username -> { password, displayName, avatar, id }
  messages: {},    // chatId -> [messages]
  chats: {}        // chatId -> { id, type, name, members: [], lastMessage, lastTime }
};

// Load data
function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    }
  } catch (e) {
    console.error('Error loading data:', e.message);
  }
}

function saveData() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error('Error saving data:', e.message);
  }
}

loadData();

// Online users: socketId -> username
const onlineUsers = new Map();
// username -> socketId
const userSockets = new Map();

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// ========== REST API (optional helpers) ==========
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', online: onlineUsers.size });
});

// ========== SOCKET.IO ==========
io.on('connection', (socket) => {
  console.log('New connection:', socket.id);

  // ----- AUTH -----
  socket.on('register', ({ username, password, displayName }, callback) => {
    username = (username || '').trim().toLowerCase();
    displayName = (displayName || username).trim();

    if (!username || username.length < 2) {
      return callback({ success: false, error: 'Имя слишком короткое' });
    }
    if (!password || password.length < 3) {
      return callback({ success: false, error: 'Пароль слишком короткий' });
    }
    if (data.users[username]) {
      return callback({ success: false, error: 'Пользователь уже существует' });
    }

    const id = uuidv4();
    data.users[username] = {
      id,
      username,
      password, // В реальном проекте хэшировать!
      displayName,
      avatar: displayName[0].toUpperCase(),
      createdAt: Date.now()
    };
    saveData();

    callback({ success: true, user: { username, displayName, avatar: data.users[username].avatar, id } });
  });

  socket.on('login', ({ username, password }, callback) => {
    username = (username || '').trim().toLowerCase();
    const user = data.users[username];

    if (!user || user.password !== password) {
      return callback({ success: false, error: 'Неверное имя или пароль' });
    }

    // Disconnect previous session if exists
    if (userSockets.has(username)) {
      const oldSocketId = userSockets.get(username);
      const oldSocket = io.sockets.sockets.get(oldSocketId);
      if (oldSocket) {
        oldSocket.emit('force_disconnect', { reason: 'Вход с другого устройства' });
        oldSocket.disconnect(true);
      }
    }

    onlineUsers.set(socket.id, username);
    userSockets.set(username, socket.id);
    socket.username = username;
    socket.join('user:' + username);

    // Send user data + online list + chats
    const onlineList = getOnlineUsersList(username);
    const userChats = getUserChats(username);

    callback({
      success: true,
      user: {
        username: user.username,
        displayName: user.displayName,
        avatar: user.avatar,
        id: user.id
      },
      onlineUsers: onlineList,
      chats: userChats
    });

    // Notify others
    socket.broadcast.emit('user_online', {
      username: user.username,
      displayName: user.displayName,
      avatar: user.avatar
    });

    console.log(`${username} logged in. Online: ${onlineUsers.size}`);
  });

  // ----- CHATS & MESSAGES -----
  socket.on('get_chats', (callback) => {
    if (!socket.username) return callback({ success: false });
    callback({ success: true, chats: getUserChats(socket.username) });
  });

  socket.on('get_messages', ({ chatId }, callback) => {
    if (!socket.username) return callback({ success: false });
    const msgs = data.messages[chatId] || [];
    callback({ success: true, messages: msgs });
  });

  socket.on('start_private_chat', ({ targetUsername }, callback) => {
    if (!socket.username) return callback({ success: false, error: 'Не авторизован' });
    
    targetUsername = (targetUsername || '').toLowerCase();
    if (!data.users[targetUsername]) {
      return callback({ success: false, error: 'Пользователь не найден' });
    }
    if (targetUsername === socket.username) {
      return callback({ success: false, error: 'Нельзя создать чат с собой' });
    }

    const chatId = getPrivateChatId(socket.username, targetUsername);
    
    if (!data.chats[chatId]) {
      const target = data.users[targetUsername];
      data.chats[chatId] = {
        id: chatId,
        type: 'private',
        name: target.displayName,
        members: [socket.username, targetUsername].sort(),
        lastMessage: '',
        lastTime: Date.now(),
        createdAt: Date.now()
      };
      data.messages[chatId] = [];
      saveData();
    }

    const chat = formatChatForUser(data.chats[chatId], socket.username);
    callback({ success: true, chat });
  });

  socket.on('send_message', ({ chatId, text, image }, callback) => {
    if (!socket.username) return callback({ success: false, error: 'Не авторизован' });
    if (!text && !image) return callback({ success: false, error: 'Пустое сообщение' });

    const chat = data.chats[chatId];
    if (!chat || !chat.members.includes(socket.username)) {
      return callback({ success: false, error: 'Чат не найден' });
    }

    const user = data.users[socket.username];
    const message = {
      id: uuidv4(),
      chatId,
      text: text || '',
      image: image || null,
      from: socket.username,
      displayName: user.displayName,
      avatar: user.avatar,
      time: Date.now(),
      status: 'sent'
    };

    if (!data.messages[chatId]) data.messages[chatId] = [];
    data.messages[chatId].push(message);

    // Update chat
    chat.lastMessage = text ? text : '📷 Фото';
    chat.lastTime = message.time;
    saveData();

    // Send to all members of the chat
    chat.members.forEach(member => {
      const memberSocketId = userSockets.get(member);
      if (memberSocketId) {
        io.to(memberSocketId).emit('new_message', {
          message,
          chat: formatChatForUser(chat, member)
        });
      }
    });

    callback({ success: true, message });
  });

  socket.on('typing', ({ chatId, isTyping }) => {
    if (!socket.username) return;
    const chat = data.chats[chatId];
    if (!chat) return;

    chat.members.forEach(member => {
      if (member !== socket.username) {
        const memberSocketId = userSockets.get(member);
        if (memberSocketId) {
          io.to(memberSocketId).emit('user_typing', {
            chatId,
            username: socket.username,
            displayName: data.users[socket.username]?.displayName,
            isTyping
          });
        }
      }
    });
  });

  socket.on('mark_read', ({ chatId }) => {
    // Simple: just acknowledge. Can expand later.
  });

  // Get all registered users (for starting chats)
  socket.on('get_users', (callback) => {
    if (!socket.username) return callback({ success: false });
    const users = Object.values(data.users)
      .filter(u => u.username !== socket.username)
      .map(u => ({
        username: u.username,
        displayName: u.displayName,
        avatar: u.avatar,
        online: userSockets.has(u.username)
      }));
    callback({ success: true, users });
  });

  // ----- DISCONNECT -----
  socket.on('disconnect', () => {
    const username = onlineUsers.get(socket.id);
    if (username) {
      onlineUsers.delete(socket.id);
      if (userSockets.get(username) === socket.id) {
        userSockets.delete(username);
      }
      socket.broadcast.emit('user_offline', { username });
      console.log(`${username} disconnected. Online: ${onlineUsers.size}`);
    }
  });
});

// ========== HELPERS ==========
function getPrivateChatId(user1, user2) {
  return 'private_' + [user1, user2].sort().join('_');
}

function getUserChats(username) {
  return Object.values(data.chats)
    .filter(c => c.members.includes(username))
    .map(c => formatChatForUser(c, username))
    .sort((a, b) => b.lastTime - a.lastTime);
}

function formatChatForUser(chat, username) {
  let name = chat.name;
  let avatar = chat.avatar || '?';
  let online = false;

  if (chat.type === 'private') {
    const other = chat.members.find(m => m !== username);
    if (other && data.users[other]) {
      name = data.users[other].displayName;
      avatar = data.users[other].avatar;
      online = userSockets.has(other);
    }
  }

  return {
    id: chat.id,
    type: chat.type,
    name,
    avatar,
    online,
    lastMessage: chat.lastMessage,
    lastTime: chat.lastTime,
    members: chat.members
  };
}

function getOnlineUsersList(exceptUsername) {
  const list = [];
  for (const [socketId, username] of onlineUsers) {
    if (username !== exceptUsername && data.users[username]) {
      const u = data.users[username];
      list.push({
        username: u.username,
        displayName: u.displayName,
        avatar: u.avatar
      });
    }
  }
  return list;
}

// ========== START ==========
server.listen(PORT, () => {
  console.log(`\n🚀 Nexus Messenger запущен!`);
  console.log(`   Локально:  http://localhost:${PORT}`);
  console.log(`   В сети:    http://ВАШ_IP:${PORT}`);
  console.log(`\nОткрой эту ссылку в браузере на разных устройствах/вкладках,\nзарегистрируй разных пользователей и переписывайся!\n`);
});
