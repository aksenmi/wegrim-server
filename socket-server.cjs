const debug = require("debug");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const dotenv = require("dotenv");

dotenv.config({
  path:
    process.env.NODE_ENV === "development"
      ? ".env.development"
      : ".env.production",
});

const serverDebug = debug("server");

const app = express();
const port = process.env.PORT || 3002;

app.use(express.static("public"));

app.get("/", (req, res) => {
  res.send("Excalidraw collaboration server is up :)");
});

const server = http.createServer(app);
server.listen(port, () => {
  console.log(`listening on port: ${port}`);
  serverDebug(`listening on port: ${port}`);
});

const io = new Server(server, {
  transports: ["websocket", "polling"],
  cors: {
    allowedHeaders: ["Content-Type", "Authorization"],
    origin: process.env.CORS_ORIGIN || "*",
    credentials: true,
  },
  allowEIO3: true,
});

let roomUsers = {};
let rooms = {}; // 각 방의 상태를 추적하기 위한 객체

io.on("connection", (socket) => {
  console.log("New connection:", socket.id);

  socket.on("join-room", (roomID, userInfo) => {
    console.log(`User ${userInfo.name} is joining room: ${roomID}`);

    if (!userInfo || !userInfo.email || !userInfo.name) {
      console.log("Invalid user info detected");
      socket.emit("invalid-user-info", "유효하지 않은 사용자 정보입니다.");
      return;
    }

    socket.join(roomID);

    if (!roomUsers[roomID]) {
      roomUsers[roomID] = [];
    }

    // 중복된 이메일을 가진 사용자가 있으면 제거
    const existingUserIndex = roomUsers[roomID]?.findIndex(
      (user) => user.email === userInfo.email
    );

    if (existingUserIndex !== -1) {
      console.log(
        `Duplicate email detected for ${userInfo.email}, replacing existing user.`
      );
      roomUsers[roomID].splice(existingUserIndex, 1); // 기존 사용자 제거
    }

    roomUsers[roomID].push({
      id: socket.id,
      email: userInfo.email,
      name: userInfo.name,
      isOwner: userInfo.isOwner || false,
    });

    // 방장인 경우 방의 상태를 설정
    if (userInfo.isOwner) {
      rooms[roomID] = rooms[roomID] || {};
      rooms[roomID].isOnAir = true;
      rooms[roomID].ownerId = socket.id;

      // 방장의 헬스 체크를 위한 타임아웃 설정
      if (rooms[roomID].ownerHeartbeatTimeout) {
        clearTimeout(rooms[roomID].ownerHeartbeatTimeout);
      }

      // 방장의 마지막 헬스 체크 시간을 현재로 설정
      rooms[roomID].lastHeartbeat = Date.now();

      io.to(roomID).emit("room-status-changed", { isOnAir: true });
      console.log(`Room ${roomID} is now on air`);
    }

    // 현재 방의 isOnAir 상태를 새로 입장한 사용자에게 전송
    if (rooms[roomID]) {
      socket.emit("room-status-changed", { isOnAir: rooms[roomID].isOnAir });
    } else {
      socket.emit("room-status-changed", { isOnAir: false });
    }

    console.log(roomUsers[roomID]);

    // 사용자 목록을 방에 있는 모든 사용자에게 전송
    io.to(roomID).emit("room-user-list", roomUsers[roomID]);
  });

  // 방장으로부터 헬스 체크 메시지 수신
  socket.on("owner-heartbeat", (roomID) => {
    if (rooms[roomID] && rooms[roomID].ownerId === socket.id) {
      rooms[roomID].lastHeartbeat = Date.now();
      // 기존 타임아웃이 있으면 재설정
      if (rooms[roomID].ownerHeartbeatTimeout) {
        clearTimeout(rooms[roomID].ownerHeartbeatTimeout);
      }
      // 새로운 타임아웃 설정
      rooms[roomID].ownerHeartbeatTimeout = setTimeout(() => {
        rooms[roomID].isOnAir = false;
        io.to(roomID).emit("room-status-changed", { isOnAir: false });
        console.log(
          `Room ${roomID} is no longer on air due to heartbeat timeout`
        );
      }, 10000); // 10초 후 타임아웃 발생
    }
  });

  socket.on("disconnect", () => {
    console.log("User disconnected:", socket.id);

    for (const roomID in roomUsers) {
      // 연결 해제한 사용자 제거
      const userIndex = roomUsers[roomID].findIndex(
        (user) => user.id === socket.id
      );

      if (userIndex !== -1) {
        const user = roomUsers[roomID][userIndex];
        roomUsers[roomID].splice(userIndex, 1);

        // 방장의 연결 해제 확인
        if (rooms[roomID] && rooms[roomID].ownerId === socket.id) {
          console.log(`Owner disconnected from room ${roomID}`);

          // 헬스 체크 타임아웃이 이미 설정되어 있다면 그대로 유지
          // 또는 즉시 isOnAir를 false로 설정할 수도 있음
          rooms[roomID].isOnAir = false;
          io.to(roomID).emit("room-status-changed", { isOnAir: false });
          console.log(`Room ${roomID} is no longer on air`);
        }

        // 사용자 목록을 방에 있는 모든 사용자에게 전송
        io.to(roomID).emit("room-user-list", roomUsers[roomID]);
      }

      // 방에 사용자가 없으면 방 정보 삭제
      if (roomUsers[roomID].length === 0) {
        delete roomUsers[roomID];
        if (rooms[roomID]) {
          // 헬스 체크 타임아웃이 설정되어 있다면 취소
          if (rooms[roomID].ownerHeartbeatTimeout) {
            clearTimeout(rooms[roomID].ownerHeartbeatTimeout);
          }
          delete rooms[roomID];
        }
        console.log(`Room ${roomID} has been deleted`);
      }
    }
  });

  socket.on("send-message", (roomID, message, userInfo) => {
    console.log(`Message from ${userInfo.name} in room ${roomID}: ${message}`);

    const messageData = {
      message,
      user: userInfo.name,
      timestamp: new Date().toISOString(),
    };

    // 해당 방에 있는 모든 클라이언트에게 메시지 전달
    io.to(roomID).emit("receive-message", messageData);
    console.log(`Broadcasted message to room ${roomID}:`, messageData);
  });

  socket.on("server-broadcast", (roomID, updatedElements, isOwner) => {
    console.log(`방장 브로드캐스트: ${roomID}, isOwner: ${isOwner}`);
    if (isOwner && rooms[roomID] && rooms[roomID].isOnAir) {
      console.log("client-broadcast 이벤트 전송 중");
      io.to(roomID).emit("client-broadcast", {
        elements: updatedElements,
      });
      console.log("client-broadcast 이벤트 전송됨");
    } else {
      socket.emit("not-authorized", "방장만 그림을 수정할 수 있습니다.");
    }
  });
});
