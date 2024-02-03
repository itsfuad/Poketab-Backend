
import { getRandomKey } from './keyGen.ts';
import { Key, User, _R_getAllUsersData, _R_exitUserFromSocket } from '../db/database.ts';
import { validateAvatar, validateKey, validateUserName, getLinkMetadata } from './utils.ts';
import { Server, type Socket } from "https://deno.land/x/socket_io@0.2.0/mod.ts";
import "https://deno.land/x/dotenv@v3.2.2/load.ts";
import { redis } from "../db/database.ts";
import { _R_deleteChatKey } from '../db/database.ts';
import { _R_joinChat } from '../db/database.ts';

const { clienturl } = Deno.env.toObject();

export const io = new Server({
  cors: {
    origin: clienturl,
    methods: ["GET", "POST"],
    credentials: true
  }
});

console.log('Socket.io server initialized');


io.on('connection', (socket) => {

  console.log('Socket Connected');

  socket.on('fetchKeyData', async (key: string, ssr: boolean, callback: (data: object | null) => void) => {

    if (!redis.isConnected) {
      console.log('Redis not connected');
      redis.connect();
      callback({ success: false, message: 'Database disconnected', statusCode: 502, icon: 'fa-solid fa-triangle-exclamation', users: {}, maxUsers: null })
      return;
    }

    console.log('fetchKeyData for key: ', key);

    if (!validateKey(key)) {
      callback({ success: false, message: 'Invalid Key', statusCode: 400, icon: 'fa-solid fa-triangle-exclamation', users: {}, maxUsers: null });
      return;
    }

    console.log('Searching database...');


    try {

      const exists = await redis.exists(`chat:${key}`);

      if (!exists) {
        console.log('Key Does Not Exist');
        callback({ success: false, message: 'Key Does Not Exist', statusCode: 404, icon: 'fa-solid fa-ghost', users: {}, maxUsers: null });
        return;
      }

      const keyData = await redis.hmget(`chat:${key}`, 'activeUsers', 'maxUsers');

      if (!keyData) {
        console.log('Key Data Not Found');
        callback({ success: false, message: 'Key Data Not Found', statusCode: 404, icon: 'fa-solid fa-ghost', users: {}, maxUsers: null });
        return;
      }

      //const [ activeUsers, maxUsers ] = keyData as [string, string];
      const activeUsers = parseInt(keyData[0] as string);
      const maxUsers = parseInt(keyData[1] as string);

      if (activeUsers >= maxUsers) {
        callback({ success: false, message: 'Key Full', statusCode: 401, icon: 'fa-solid fa-door-closed', users: {}, maxUsers: null });
        return;
      }

      const users = await _R_getAllUsersData(key);

      if (!ssr){
        socket.join(`waitingRoom:${key}`);
        console.log(socket.id, 'joined waiting room for key: ', key);
      }

      callback({ success: true, message: 'Available', statusCode: 200, icon: '', users: { ...users }, maxUsers: maxUsers });
    } catch (error) {
      console.error(error);
      callback({ success: false, message: 'Server Error', statusCode: 500, icon: 'fa-solid fa-triangle-exclamation', users: {}, maxUsers: null });
    }
  });


  socket.on('createChat', async (name: string, avatar: string, maxUsers: number, callback: (data: object | null) => void) => {

    console.log('createChat requested');

    if (!redis.isConnected) {
      callback({ success: false, message: 'Database disconnected', statusCode: 502, icon: 'fa-solid fa-triangle-exclamation', users: {}, maxUsers: null })
      //try to reconnect
      redis.connect();
      return;
    }

    if (!validateUserName(name)) {
      callback({ success: false, message: 'Invalid name', icon: 'fa-solid fa-triangle-exclamation' });
      return;
    }

    if (!validateAvatar(avatar)) {
      callback({ success: false, message: 'Invalid Avatar', icon: 'fa-solid fa-triangle-exclamation' });
      return;
    }

    if (maxUsers < 2 || maxUsers > 10) {
      callback({ success: false, message: 'Invalid Max Users', icon: 'fa-solid fa-triangle-exclamation' });
      return;
    }

    try {
      const uid = crypto.randomUUID();
      const key = await getRandomKey();

      socket.join(`chat:${key}`);
      socket.leave(`waitingRoom:${key}`);
      console.log(socket.id, 'left waiting room for key: ', key);

      const chatKey: Key = {
        keyId: key,
        activeUsers: 1,
        maxUsers,
        admin: uid,
        createdAt: Date.now(),
      }

      const user: User = {
        name,
        avatar,
        uid,
        joinedAt: Date.now(),
      }

      await _R_joinChat(true, chatKey, user, socket.id);

      callback({ success: true, message: 'Chat Created', key, userId: uid, maxUsers: maxUsers });

      //get name, avatar, and id of all users in the room
      const me = { name, avatar, uid };

      console.log('Chat Created');
      io.in(`chat:${key}`).emit('updateUserList', { [uid]: me });
      console.log(`sent update user list to ${key}. users count: 1`);
      io.in(`waitingRoom:${key}`).emit('updateUserListWR', { [uid]: me });
      
      //only sender
      socket.emit('server_message', { text: 'You joined the that🔥', id: crypto.randomUUID() }, 'join');

      socket.on('disconnect', async () => {
        console.log(`Chat Socket ${socket.id} Disconnected`);
        await exitSocket(socket, key);
      });

      socket.on('leaveChat', async (callback) => {
        await exitSocket(socket, key);
        console.log('Chat Left');
        callback();
      });

    } catch (error) {
      console.error(error);
      callback({ success: false, message: 'Chat Creation Failed', icon: 'fa-solid fa-triangle-exclamation' });
    }
  });

  socket.on('joinChat', async (key: string, name: string, avatar: string, callback: (data: object | null) => void) => {
    console.log('joinChat requested');

    if (!redis.isConnected) {
      callback({ success: false, message: 'Database disconnected', statusCode: 502, icon: 'fa-solid fa-triangle-exclamation', users: {}, maxUsers: null })
      //try to reconnect
      redis.connect();
      return;
    }

    if (!validateKey(key)) {
      callback({ success: false, message: 'Invalid Key', icon: 'fa-solid fa-triangle-exclamation' });
      return;
    }

    if (!validateUserName(name)) {
      callback({ success: false, message: 'Invalid name', icon: 'fa-solid fa-triangle-exclamation' });
      return;
    }

    if (!validateAvatar(avatar)) {
      callback({ success: false, message: 'Invalid Avatar', icon: 'fa-solid fa-triangle-exclamation' });
      return;
    }

    try {

      if (await redis.exists(`chat:${key}`)) {

        //const reply = await redis.sendCommand('JSON.GET', [`chat:${key}`,  'activeUsers', 'maxUsers', 'users']);
        const keyData = await redis.hmget(`chat:${key}`, 'activeUsers', 'maxUsers');

        if (keyData) {

          //const { activeUsers, maxUsers, users } = JSON.parse(reply as string) as Key;
          const activeUsers = parseInt(keyData[0] as string);
          const maxUsers = parseInt(keyData[1] as string);

          if (activeUsers >= maxUsers) {
            callback({ success: false, message: 'Chat Full', icon: 'fa-solid fa-door-closed' });
            return;
          }

          const uid = crypto.randomUUID();

          const me: User = {
            name: name,
            avatar,
            uid,
            joinedAt: Date.now(),
          };

          socket.join(`chat:${key}`);
          socket.leave(`waitingRoom:${key}`);
          console.log(socket.id, 'left waiting room for key: ', key);

          await _R_joinChat(false, { keyId: key }, me, socket.id);
          
          let users: { [key: string]: Omit<User, 'joined'> } = {}; //omit the joined property

          users = await _R_getAllUsersData(key),

          callback({ success: true, message: 'Chat Joined', key, userId: uid, maxUsers: maxUsers });

          console.log('Chat Joined');

          //log the connected users on that room
          io.in(`chat:${key}`).emit('updateUserList', { ...users, [uid]: me });
          console.log(`sent update user list to ${key}. users count: ${activeUsers + 1}`);
          io.in(`waitingRoom:${key}`).emit('updateUserListWR', { ...users, [uid]: me });

          //only sender
          socket.emit('server_message', { text: 'You joined the that🔥', id: crypto.randomUUID() }, 'join');

          //broadcast
          socket.in(`chat:${key}`).emit('server_message', { text: `${name} joined the that🔥`, id: crypto.randomUUID() }, 'join');

          socket.on('disconnect', async () => {
            console.log(`Chat Socket ${socket.id} Disconnected`);
            await exitSocket(socket, key);
          });

          socket.on('leaveChat', async (callback) => {
            await exitSocket(socket, key);
            console.log('Chat Left');
            callback();
          });


        } else {
          // Handle the case where the data doesn't exist or is null.
          callback({ success: false, message: 'Key Data Not Found', icon: 'fa-solid fa-ghost' });
        }

      } else {
        callback({ success: false, message: 'Key Does Not Exist', icon: 'fa-solid fa-ghost' });
        return;
      }

    } catch (error) {
      console.error(error);
      callback({ success: false, message: 'Chat Join Failed' });
    }
  });

  socket.on('newMessage', (message, key: string, callback: (data: string | null) => void) => {

    const messageId = crypto.randomUUID();
    //broadcast
    socket.in(`chat:${key}`).emit('newMessage', message, messageId);

    callback(messageId);

    console.log(message.type);
    if (message.type === 'text') {
      getLinkMetadata(message.message).then((data) => {
        console.log(data);
        if (data.success) {
          //everyone in room
          io.in(`chat:${key}`).emit('linkPreviewData', messageId, data.data);
        }
      });
    }
  });

  socket.on('deleteMessage', (messageId: string, key: string, userId: string) => {
    //send back to all users in the room including the sender
    io.in(`chat:${key}`).emit('deleteMessage', messageId, userId);
  });


  socket.on('react', (messageId: string, key: string, userId: string, react: string) => {
    //everyone in room including sender
    io.in(`chat:${key}`).emit('react', messageId, userId, react);
  });

  socket.on('seen', (uid: string, key: string, msgId: string) => {
    //broadcast
    socket.in(`chat:${key}`).emit('seen', uid, msgId);
  });

  socket.on('typing', (uid: string, key: string, event: string) => {
    //broadcast
    socket.in(`chat:${key}`).emit('typing', uid, event);
  });

  socket.on('location', (position, key, uid) => {
    const messageId = crypto.randomUUID();
    //everyone in room including sender
    io.in(`chat:${key}`).emit('location', position, messageId, uid);
  });
});

async function exitSocket(socket: Socket, key: string) {

  socket.leave(`waitingRoom:${key}`);
  socket.leave(`chat:${key}`);

  //if socket not exists in redis, return
  if (!await redis.exists(`socket:${socket.id}`)) {
    console.log('Socket no longer exists in database');
    return;
  }
  //get uid from redis
  let data = await redis.hmget(`socket:${socket.id}`, 'name', 'uid');

  if (!data) {
    console.log('Socket Data Not Found');
    return;
  }

  const [ name, uid ] = data as [string, string];

  await _R_exitUserFromSocket(key, uid, socket.id);

  console.log(`User ${name} left ${key}`);
  
  socket.in(`chat:${key}`).emit('server_message', { text: `${name} left the chat😭`, id: crypto.randomUUID() }, 'leave');

  data = await redis.hmget(`chat:${key}`, 'activeUsers');

  if (!data) {
    console.log('Empty key');
    return;
  }

  const [activeUsers] = data as unknown as [number];

  if (activeUsers > 0) {
    const users = await _R_getAllUsersData(key) as { [key: string]: Omit<User, 'joined'> };
    console.log(`sent update user list to ${key}. users count: ${activeUsers}`);
    io.in(`chat:${key}`).emit('updateUserList', users);
    io.in(`waitingRoom:${key}`).emit('updateUserListWR', users);
  } else {
    await _R_deleteChatKey(key, socket.id);
    console.log('Key deleted');
    io.in(`chat:${key}`).emit('updateUserList', {});
    console.log(`sent update user list to ${key}. users count: 0`);
    io.in(`waitingRoom:${key}`).emit('updateUserListWR', {});
  }
}