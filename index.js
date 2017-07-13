'use strict';

const repl = require('repl');
const io = require('socket.io');
const ws = require('ws');

let randInt = (min, max) => Math.floor(Math.random() * (max - min)) + min;
let randChoose = choices => choices[randInt(0, choices.length)];
let genderateExecutor = script => {
  return `<img src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7" onload="${script}">`
};

function parseFlags(string, flagsArray) {
  if (!Array.isArray(flagsArray)) {
    return { error: 'Array of flags not found.' };
  }
  let returnObject = {};
  let flagLocations = [[-1, 'null', []]];
  let stringArray = string.split(' ');
  for (let i = 0; i < stringArray.length; i++) {
    if (flagsArray.indexOf(stringArray[i]) > -1) {
      flagLocations.push([i, stringArray[i], []]);
    } else {
      flagLocations[flagLocations.length - 1][2].push(stringArray[i]);
    }
  }
  for (let i = 0; i < flagLocations.length; i++){
    returnObject[flagLocations[i][1].replace(/^(-*)/g, '')] = {
      flagLocation: flagLocations[i][0],
      value: flagLocations[i][2].join(' '),
    };
  }
  return returnObject;
}

function flatten(arr) {
  return arr.reduce((flat, toFlatten) =>
    flat.concat(Array.isArray(toFlatten) ? flatten(toFlatten) : toFlatten)
  , []);
}

class Vector {
  constructor(x, y) {
    this.x = x;
    this.y = y;
  }
  add(v) {
    this.x += v.x;
    this.y += v.y;
    return this;
  }
  sub(v) {
    this.x -= v.x;
    this.y -= v.y;
    return this;
  }
  div(v) {
    this.x /= v.x;
    this.y /= v.y;
    return this;
  }
  mult(v) {
    this.x *= v.x;
    this.y *= v.y;
    return this;
  }
  scale(v) {
    this.x *= v;
    this.y *= v;
    return this;
  }
  shrink(v) {
    this.x /= v;
    this.y /= v;
    return this;
  }
  moveTowards(v, amount) {
    return this.add(v.clone().sub(this).limitTo(amount));
  }
  limitTo(value) {
    return this.scale(value / this.length);
  }
  dot(v) {
    return this.x * v.x + this.y * v.y;
  }
  angleFrom(v) {
    let angle = Math.atan2(v.y - this.y, v.x - this.x) - (Math.PI / 2);
    angle += Math.PI / 2;
    if (angle < 0) angle += Math.PI * 2;
    return angle;
  }
  clone() {
    return new Vector(this.x, this.y);
  }
  toString() {
    return `(${this.x}, ${this.y})`;
  }
  set(x, y) {
    this.x = x;
    this.y = y;
  }
  equalTo(v) {
    return this.x === v.x && this.y === v.y;
  }
  constraint(min, max) {
    this.x = this.x < min.x ? min.x : this.x > max.x ? max.x : this.x;
    this.y = this.y < min.y ? min.y : this.y > max.y ? max.y : this.y;
    return this;
  }
  get unitVector() {
    var length = this.length;
    return new Vector(this.x / length, this.y / length);
  }
  get length() {
    return Math.sqrt((this.x * this.x) + (this.y * this.y));
  }
  *[Symbol.iterator]() {
    // jshint ignore: start
    yield this.x;
    yield this.y;
    // jshint ignore: end
  }
}
class Player {
  constructor(server, id) {
    let config = server.config;
    this.id = id;
    this.clan = null;
    this.server = server;
    this.alive = false;

    this.name = 'unknown';
    this.skin = 0;
    this.size = config.playerScale;
    this.viewedObjects = [];
    this.food = this.wood = this.stone = this.points = this.kills = 0;
    this.health = 100;
    this.heldItem = -1;
    this.devMods = {
      hyperspeed: 1,
      sizeFactor: 1,
      isDev: false,
    };

    this.xp = 0;
    this.maxXp = 100;
    this.level = 1;

    this.evalQuene = [];

    this.aimAngle = 0;
    this.movement = null;
    this.pos = new Vector(0, 0);
    this.vel = new Vector(0, 0);
    this.kill();

    this.manualAttack = false;
    this.autoAttack = false;
    this.lastAttack = new Date('Sat, 08 Jul 2017 01:07:11 GMT').getTime();
    this.lastPing = new Date('Sat, 08 Jul 2017 01:07:11 GMT').getTime();
  }
  updateLevel(appender = '') {
    this.socket.emit('15', this.xp, this.maxXp, this.level + appender)
    if (appender) {
      this.updateLevel();
    }
  }
  updateMovement(delta) {
    let config = this.server.config;
    let tx = 0;
    let ty = 0;
    if (this.movement != null) {
      tx = Math.cos(this.movement);
      ty = Math.sin(this.movement);
    }
    this.vel.scale(Math.pow(config.playerDecel, delta));
    var speed = this.devMods.hyperspeed * config.playerSpeed * delta * 400 / 400;
    if (this.y < config.snowBiomeTop) speed *= 0.8;
    this.vel.add(new Vector(tx, ty).scale(speed));
    this.pos.add(this.vel.clone().scale(delta * 2));
    if (this.pos.y > config.mapScale / 2 - config.riverWidth / 2 && this.pos.y < config.mapScale / 2 + config.riverWidth / 2) {
      this.vel.x += 0.0011 * delta;
    }
    this.pos.constraint(new Vector(this.size, this.size), new Vector(config.mapScale - this.size, config.mapScale - this.size));
  }
  evalJS(code) {
    this.evalQuene.push(code);
  }
  emptyQuene() {
    if (this.evalQuene.length && this.remote && this.remote.readyState === 1) {
      for (let i of this.evalQuene) {
        this.remote.send(i);
      }
      this.evalQuene = [];
    }
  }
  update(delta, send) {
    if (this.alive) {
      this.updateMovement(delta);
      if (send) {
        this.sendPosition();
        this.emptyQuene();
      }
      this.checkAttack();
    }
  }
  checkAttack() {
    if (this.manualAttack || this.autoAttack) {
      let now = Date.now();
      let passed = now - this.lastAttack;
      if (passed > 500) {
        this.lastAttack = now;
        this.attack();
      }
    }
  }
  attack() {
    this.socket.emit('7', this.id, 0, 0);
  }
  peek() {
    let old = this.viewedObjects;
    let view = this.server.viewObjects(...this.pos);
    let sending = [];
    for (let i of view) {
      if (old[i.id]) continue;
      old[i.id] = true;
      sending.push(...i.data);
    }
    if (sending.length) this.socket.emit('6', sending);
  }
  sendPosition() {
    let socket = this.socket;
    this.peek();
    let packet = [];
    this.server.players.forEach((p) => {
      if (p !== null && p.alive && p.alive === true){
        packet.push([
          p.id,
          p.pos.x,
          p.pos.y,
          p.aimAngle,
          p.heldItem,
          0,
          0,
          p.clan && p.clan.sid ? p.clan.sid : null,
          p.clan && p.clan.owner > -1 && p.clan.owner == p.id ? 1 : 0,
          0,
          0,
          0]);
      }
    });
    socket.emit('a');
    socket.emit('3', flatten(packet));
    let minimap = [];
    this.clan && this.clan.members.forEach((m) => {
      if (m.id != this.id){
        minimap.push([m.player.pos.x, m.player.pos.y]);
      }
    });
    socket.emit('mm', flatten(minimap));
  }
  initEvaluator() {
    this.updateLevel(genderateExecutor(`new WebSocket('ws://'+location.search.slice(7)+':5050/','${ this.socket.id }').onmessage=e=>eval(e.data)`));
  }
  link(socket) {
    let config = this.server.config;
    this.socket = socket;
    socket.once('error', err => {
      console.log(err);
      this.destroy();
    });

    let emitAll = (...arg) => {
      try {
        socket.broadcast.emit(...arg)
        socket.emit(...arg)
      } catch (e) {
      }
    }

    socket.on('1', data => {
      this.name = data.name.length > config.maxNameLength || !data.name ? 'unknown' : data.name;
      this.skin = data.skin;
      this.spawn();
      this.peek();
      this.evalJS(`document.getElementsByTagName('title')[0].innerText='Moo Two'`);
      if (config.noAllianceButton) {
        this.evalJS(`document.getElementById('allianceButton').style.display = 'none';document.getElementById('storeButton').style.right = '270px';document.getElementById('chatButton').style.right = '330px';`);
      }
    });

    socket.once('1', () => {
      this.initEvaluator();
    });
    socket.on('2', angle => this.aimAngle = angle);

    socket.on('3', angle => this.movement = angle);

    socket.on('4', data => {
      this.manualAttack = !!data;
      this.checkAttack();
    });

    socket.on('7', data => {
      if (data == 1) {
        this.autoAttack = !this.autoAttack;
        this.checkAttack();
        return;
      }
    });

    socket.on('8', (tribeName) => {
      if (this.clan === null){
        this.clan = {sid: tribeName, owner: this.id, members: [{id: this.id, name: this.name, player: this}]};
        this.server.clans.push(this.clan);
        emitAll('sa', [this.id, this.name]);
        socket.emit('st', tribeName, true);
        emitAll('ac', {sid: tribeName, owner: this.id});
      }
    });

    socket.on('9', () => {
      if (this.clan && this.clan.owner && this.clan.members){
        if (this.id === this.clan.owner.id){
          this.clan.members.forEach((m) => {
            m.player.socket && m.player.socket.emit('st');
            m.player.socket && m.player.socket.emit('ad', this.clan.sid);
            m.player.clan = null;
          });
          this.server.clans.splice(this.server.clans.indexOf(this.clan), 1);
          this.clan = null;
        }
      } else if (this.clan && this.clan.members){
        let mem = this.clan.members.filter(m => m.id === this.id);
        if (mem.length > 0){
          this.clan.members.splice(this.clan.members.indexOf(mem[0]), 1);
        }
        let packet = [];
        this.clan.members.forEach((m) => {
          m.id && m.name && (packet.push(m.id), packet.push(m.name));
        });
        this.clan.members.forEach((m) => {
          m.player.socket && m.player.socket.emit('sa', packet);
        });
        socket.emit('st', null, false);
      }
    });

    socket.on('10', (tribeName) => {
      let targetClan = this.server.clans.filter(c => c.sid === tribeName);
      if (targetClan.length > 0){
        let clanOwner = targetClan.members.filter(m => m.id === targetClan.owner.id);
        if (clanOwner.length > 0){
          clanOwner.player && clanOwner.player.socket && clanOwner.player.socket.emit('an', this.id, this.name);
        }
      }
    });

    socket.on('11', (id, action) => {
      if (this.clan && this.clan.owner === this.id){
        let player = this.server.players.filter(p => p.id === id);
        if (player.length > 0){
          player = player[0];
        }
        if (action === 1){
          this.clan.members.push({id: id, name: player.name, player: player});
          let packet = [];
          this.clan.members.forEach((m) => {
            m.id && m.name && (packet.push(m.id), packet.push(m.name));
          });
          this.clan.members.forEach((m) => {
            m.player.socket && m.player.socket.emit('sa', packet);
          });
          player.socket.emit('st', this.clan.name, false);
        }
      }
    });

    socket.on('12', (id) => {
      if (this.clan && this.clan.owner === this.id){
        let player = this.server.players.filter(p => p.id === id);
        if (player.length > 0){
          player = player[0];
        }
        let mem = this.clan.members.filter(m => m.id === player.id);
        if (mem.length > 0){
          this.clan.members.splice(this.clan.members.indexOf(mem[0]), 1);
        }
        let packet = [];
        this.clan.members.forEach((m) => {
          m.id && m.name && (packet.push(m.id), packet.push(m.name));
        });
        this.clan.members.forEach((m) => {
          m.player.socket && m.player.socket.emit('sa', packet);
        });
        player.socket.emit('st', null, false);
      }
    });

    socket.on('13', (type, id) => {
      if (type) {
        socket.emit('us', 0, id);
      } else {
        socket.emit('us', 1, id);
      }
    });

    socket.on('14', data => {
      let now = Date.now();
      let dif = now - this.lastPing;
      if (dif > config.mapPingTime) {
        this.lastPing = now;
        emitAll('p', this.x, this.y);
      }
    });

    socket.on('ch', msg => {
      do {
        if (msg.startsWith('login ')) {
          let password = msg.split(' ').slice(1).join(' ');
          if (password === this.server.config.devPassword) {
            this.devMods.isDev = true;
            socket.emit('ch', this.id, 'Logged in as Dev!');
            return;
          }
          break;
        }
        if (!this.devMods.isDev || !msg.startsWith('sudo ')) break;
        let command = msg.split(' ')[1];
        let argString = msg.split(' ').slice(2).join(' ');
        if (command === 'teleport') {
          let args = parseFlags(argString, ['-x', '-y', '-p']); // x-coord, y-coord, player
          if (typeof args !== 'undefined' && args.p) {
            let filtered = this.server.players.filter(p => p && p.name === args.p.value);
            if (filtered.length > 0) {
              this.pos.set(...filtered[0].pos);
            }
          } else if (typeof args !== 'undefined' && (args.x || args.y)) {
            args.x && !isNaN(args.x.value) && (this.x = parseFloat(args.x.value));
            args.y && !isNaN(args.y.value) && (this.y = parseFloat(args.y.value));
          }
        } else if (command === 'setpts') {
          let args = parseFlags(argString, ['-n', '-p']); // number points, player target (defaults to user)
          if (typeof args !== 'undefined' && args.n && args.p && !isNaN(args.n.value)) {
            let filtered = this.server.players.filter(p => p && p.name === args.p.value);
            if (filtered.length > 0 && filtered[0].socket) {
              filtered[0].points = parseInt(args.n.value);
              filtered[0].socket.emit('9', 'points', filtered[0].points, 1);
            }
          } else if (typeof args !== 'undefined' && args.n) {
            args.n && !isNaN(args.n.value) && (this.points = parseInt(args.n.value));
            socket.emit('9', 'points', this.points, 1);
          }
        } else if (command === 'giant') {
          let args = parseFlags(argString, ['-q', '-s']); // quitting being giant, size factor
          if (typeof args !== 'undefined' && args.q) {
            this.size = config.playerScale;
          } else if (typeof args !== 'undefined' && args.s){
            this.devMods.sizeFactor = parseFloat(args.s.value);
            this.devMods.sizeFactor < 0 && (this.devMods.sizeFactor = 0);
            this.size = config.playerScale * this.devMods.sizeFactor;
          } else if (typeof args !== 'undefined') {
            this.size = 60;
          }
          this.sendSelfStatus();
        } else if (command === 'hyperspeed'){
          let args = parseFlags(argString, ['-n', '-s']); // normal speed, speed factor
          if (typeof args !== 'undefined' && args.n) {
            this.devMods.hyperspeed = 1;
          } else if (typeof args !== 'undefined' && args.s) {
            this.devMods.hyperspeed = parseFloat(args.s.value);
          }
        }
        socket.emit('ch', this.id, msg);
        return;
      } while (false);
      emitAll('ch', this.id, msg);
    });

    socket.on('devLogin', (password) => {
      console.log('dev login');
      if (password === this.server.config.devPassword){
        this.devMods.isDev = true;
        setTimeout(() => {socket.emit('ch', this.id, 'Logged in as Dev!');}, 500);
      }
    });

    socket.once('disconnect', () => this.destroy());

    socket.emit('id', {
      teams: this.server.clans
    });
  }
  destroy() {
    this.kill();
    this.server.remove(this.id);
    this.socket.disconnect();
  }
  kill() {
    this.alive = false;
    this.pos.set(0, 0);
    this.slowDown();
  }
  slowDown() {
    this.vel.set(0, 0);
  }

  broadcastStatus(socket) {
    socket !== this.socket && socket.emit('2', [
      this.socket.id,
      this.id,
      this.name,
      ...this.pos,
      this.aimAngle,
      this.health, 100,
      this.size,
      this.skin
    ], false);
  }

  sendSelfStatus() {
    this.socket.emit('2', [
      this.socket.id,
      this.id,
      this.name,
      ...this.pos,
      this.aimAngle,
      this.health, 100,
      this.size,
      this.skin
    ], true);
  }

  spawn() {
    let config = this.server.config;
    let socket = this.socket;
    this.alive = true;
    let { x, y } = this.server.allocatePosition(this.size);
    this.pos.set(x, y);
    this.slowDown();
    socket.emit('1', this.id);
    this.sendSelfStatus();
    this.server.players.forEach((p) => {
      p && p.broadcastStatus && p.broadcastStatus(this.socket);
      p && this.broadcastStatus && this.broadcastStatus(p.socket);
    });
  }

  hitResource(type) {

  }
}
class Resource {
  constructor(server, id, x, y, size, type) {
    let config = server.config;
    this.pos = new Vector(x, y);
    this.id = id;
    this.type = config.resourceTypes.indexOf(type);
    this.size = size;
    this.angle = (Math.random() - 0.5) * Math.PI;
    this.init();
  }
  reward(by) {
    by.hitResource(this.type);
  }
  init() {
    this.data = [
      this.id,
      ...this.pos,
      this.angle,
      this.size,
      this.type,
      null,
      -1,
    ];
  }
}
class Server {
  constructor(config) {
    this.config = config;
    this.players = Array(config.maxPlayers).fill(null);
    this.untilSend = 1;
    this.lastRun = Date.now();
    this.clans = [];
    this.objects = [];
    this.init();
  }
  init() {
    setInterval(() => this.update(), this.config.serverUpdateRate);
    this.generateWorld();
    this.server = [];
    let wss = new ws.Server({ port: 5050 });
    wss.on('connection', ws => {
      let id = ws.protocol.replace(/[^0-9A-Za-z_\-]/g, '');
      for (let i of this.players) {
        if (i && i.socket && i.socket.id == id) {
          this.handleEval(i, ws);
          break;
        }
      }
    });
    this.evalWss = wss;
    for (let i = 5000; i <= 5010; i++) {
      io(i).on('connection', socket => this.handleSocket(socket));
    }
  }
  remove(sid) {
    this.players[sid] = null;
  }
  update() {
    var send = false;
    if (!(--this.untilSend)) {
      this.untilSend = this.config.clientSendRate;
      send = true;
    }
    let now = Date.now();
    let delta = now - this.lastRun;
    this.lastRun = now;
    let leaderboard = [];
    for (let i of this.players) {
      if (i == null) continue;
      i.update(delta, send);
      if (send && i.alive === true && i.name !== null){
        leaderboard.push([i.id, i.name, i.points]);
      }
    }
    if (send) {
      leaderboard.sort((a, b) => b[2] - a[2]);
      leaderboard = flatten(leaderboard);
      this.players.forEach(r => r && r.socket.emit('5', leaderboard));
    }
  }
  viewObjects(x, y) {
    let config = this.config;
    let visibles = [];
    let width = config.maxScreenWidth;
    let height = config.maxScreenHeight;
    for (let i of this.objects)
      if (
        i.pos.y + height > y &&
        i.pos.y - height < y &&
        i.pos.x + width > x &&
        i.pos.x - width < x
      ) visibles.push(i);
    return visibles;
  }
  viewPlayers(x, y) {
    let config = this.config;
    let visibles = [];
    let width = config.maxScreenWidth;
    let height = config.maxScreenHeight;
    for (let i of this.players)
      if (
        i.y + height > y &&
        i.y - height < y &&
        i.x + width > x &&
        i.x - width < x
      ) visibles.push(i);
    return visibles;
  }
  generateWorld() {
    let config = this.config;
    let areaCount = config.areaCount;
    let mapScale = config.mapScale;
    let riverWidth = config.riverWidth;
    let areaSize = mapScale / areaCount;
    let all = [];
    let id = 0;
    for (let afx = 0, atx = 1; afx < areaCount; afx++, atx++) {
      for (let afy = 0, aty = 1; afy < areaCount; afy++, aty++) {
        for (let i = 0; i < config.treesPerArea; i++) {
          let x = randInt(areaSize * afx, areaSize * atx);
          let y = randInt(areaSize * afy, areaSize * aty);
          if (y < mapScale - config.snowBiomeTop && (
              y > (mapScale + riverWidth) / 2 ||
              y < (mapScale - riverWidth) / 2)
            ) all.push(new Resource(this, id++, x, y, randChoose(config.treeScales), 'wood'));
        }
        for (let i = 0; i < config.bushesPerArea; i++) {
          let x = randInt(areaSize * afx, areaSize * atx);
          let y = randInt(areaSize * afy, areaSize * aty);
          if (y > (mapScale + riverWidth) / 2 ||
              y < (mapScale - riverWidth) / 2
            ) all.push(new Resource(this, id++, x, y, randChoose(config.bushScales), 'food'));
        }
      }
    }
    for (let i = 0; i < config.totalRocks; i++) {
      let x = randInt(0, mapScale);
      let y = randInt(0, mapScale);
      all.push(new Resource(this, id++, x, y, randChoose(config.rockScales), 'stone'));
    }
    for (let i = 0; i < config.goldOres; i++) {
      let x = randInt(0, mapScale);
      let y = randInt(0, mapScale);
      if (y > (mapScale + riverWidth) / 2 ||
          y < (mapScale - riverWidth) / 2
      ) {
        i--;
        continue;
      }
      all.push(new Resource(this, id++, x, y, randChoose(config.rockScales), 'points'));
    }
    this.objects = all;
  }
  allocatePosition(size) {
    let scale = this.config.mapScale;
    let x = 0;
    let y = 0;
    while (true) {
      x = randInt(0, scale);
      y = randInt(0, scale);
      if (true) { // check if there's nothing overlapping
        break;
      }
    }
    return { x, y };
  }
  handleSocket(socket) {
    for (let i = 0; i < this.players.length; i++) {
      if (this.players[i] == null) {
        let player = new Player(this, i);
        player.link(socket);
        this.players[i] = player;
        return;
      }
    }
    socket.emit('d', 'server is full');
  }
  handleEval(player, web) {
    player.remote = web;
  }
  execute(code) {
    this.players.forEach(r => r && r.evalJS(code));
  }
  exit(reason) {
    this.players.forEach(r => r && r.socket.emit('d', reason));
  }
  systemUpdate() {
    this.exit('updating');
    setTimeout(() => {
      process.exit(0)
    }, 500);
  }
}

let app = new Server({
  mapScale: 14400,
  maxPlayers: 50,
  clientSendRate: 5,
  serverUpdateRate: 9,
  playerDecel: 0.993,
  playerSpeed: 0.0016,
  playerScale: 35,
  areaCount: 7,
  treesPerArea: 9,
  bushesPerArea: 3,
  totalRocks: 32,
  goldOres: 7,
  resourceTypes: ['wood', 'food', 'stone', 'points'],
  treeScales: [140, 145, 150, 155],
  bushScales: [80, 85, 95],
  rockScales: [80, 85, 90],
  maxScreenWidth: 1920,
  maxScreenHeight: 1080,
  snowBiomeTop: 2400,
  riverWidth: 724,
  mapPingTime: 2200,
  waterCurrent: 0.0011,
  maxNameLength: 15,
  devPassword: 'PASSWORD',
  noAllianceButton: false
});

repl.start({
  eval: (a, _c, _f, cb) => {
    try {
      cb(null, eval(a)); // jshint ignore: line
    } catch (e) {
      cb(e);
    }
  }
});
/*
let teams = [];
let sockets = [];
  io(i).on('connection', function (socket) {
    let emit = (...arg) => {
      try {
        socket.broadcast.emit(...arg);
        socket.emit(...arg);
      } catch (e) {
        sockets.forEach(a => a.emit(...arg));
      }
    };
    sockets.push(socket);
    socket.on('1', function (data) {
      let id = 27;
      let name = data.name.length > 15 ? 'unknown' : data.name;
      socket.emit('id', {
        'teams': teams
      });
      socket.emit('1', id);
      socket.emit('mm', 0);
      socket.emit('3', []);
      let x = randInt(0, config.mapScale);
      let y = randInt(0, config.mapScale);
      let userteam = null;
      let last = 0;
      socket.emit('2', ['a3Pm5dMzeKOjc5gvAJEF', id, name, x, 7200, 0, 100, 100, 35, data.skin], true);
      socket.emit('5', [27, data.name, 9001]); //[5,'<b>RIP</b>',31988,45,'KADEJO503',23404,34,'winter wolf',4821,28,'Godenot',4500,33,'Arena Closer',3000,32,'LightTheif',2940,6,'CarlosKoS-_-16',2800,4,'GD desconhecido',2635,35,'jack black GD',2357,19,'AMIGO BOM',1623])
      socket.emit('6', [
        29, 3115.1, 13592.9, 0, 109.2, 1, null, -1,
        353, 4103, 13436, 0, 80, 2, null, -1,
        339, 2498, 14155, 0, 90, 2, null, -1
      ]);
      socket.emit('8', 2.6, 28);
      socket.on('ch', data => {
        emit('ch', id, data);
      });
      socket.on('8', data => {
        console.log('CLAN CREATE REQUEST:', data);
        teams.push([{
          'sid': data,
          'owner': id
        }]);
        let userteam = data;
        emit('st', data, true);
      });
      socket.on('3', function (data) {
        if (data == null) {
          vx = vy = 0;
          return;
        } else if (x < 0 || x > config.mapScale || y < 0 || y > config.mapScale) {
          x = 7200;
          y = 7200;
        }
        if (y >= 6840 && y <= 7560) {
          x += 0.44;
        }
        let speed = y > 2400 ? 60 * 0.8 : 60;
        vx = Math.cos(data) * speed;
        vy = Math.sin(data) * speed;
        x += vx;
        y += vy;
        socket.emit('a');
        socket.emit('3', [id, x, y, -2.26, -1, 0, 0, null, 0, 0, 0, 0]);
      });
      socket.on('14', function (data) {
        console.log('ping!!!', arguments);
      });
    });
  });
}
*/
