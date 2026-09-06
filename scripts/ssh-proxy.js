#!/usr/bin/env node
// SSH ProxyCommand: 把 stdin/stdout 桥接到 mihomo SOCKS5 代理（协议无关，正确转发 raw bytes）
// 用法: ssh-proxy.js <host> <port>
// mihomo 默认 SOCKS5 端口 7891（HTTP CONNECT 会假设后续是 TLS，SSH 走不通）
// SOCKS5 协议规范: https://datatracker.ietf.org/doc/html/rfc1928

const net = require('net');
const proxyHost = process.env.SSH_PROXY_HOST || '127.0.0.1';
const proxyPort = Number(process.env.SSH_PROXY_PORT || 7891);

const [, , host, portStr] = process.argv;
const port = Number(portStr);
if (!host || !port) {
  process.stderr.write(`usage: ${process.argv[1]} <host> <port>\n`);
  process.exit(2);
}

// 第一步：SOCKS5 greeting（5=版本, 1=方法数, 0=无需认证）
const greeting = Buffer.from([0x05, 0x01, 0x00]);

// 第二步：CONNECT 请求（5=版本, 1=CONNECT, 0=保留, 3=域名, len=域名长, ...域名..., 2字节端口）
const hostBuf = Buffer.from(host, 'utf8');
const portBuf = Buffer.alloc(2);
portBuf.writeUInt16BE(port, 0);
const connect = Buffer.concat([
  Buffer.from([0x05, 0x01, 0x00, 0x03, hostBuf.length]),
  hostBuf,
  portBuf,
]);

const socket = net.createConnection({ host: proxyHost, port: proxyPort }, () => {
  socket.write(greeting);
});

let phase = 'greeting';
let buf = Buffer.alloc(0);

socket.on('data', (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  if (phase === 'greeting') {
    // 期望响应: [0x05, 0x00] (VER=5, METHOD=0 无认证)
    if (buf.length < 2) return;
    if (buf[0] !== 0x05 || buf[1] !== 0x00) {
      process.stderr.write(`SOCKS5 greeting rejected: ${buf.slice(0, 2).toString('hex')}\n`);
      process.exit(1);
    }
    buf = Buffer.alloc(0);
    phase = 'connect';
    socket.write(connect);
    return;
  }
  if (phase === 'connect') {
    // 期望响应: [0x05, 0x00, 0x00, ATYP, BND.ADDR, BND.PORT] 共 6+ 字节
    if (buf.length < 4) return;
    if (buf[0] !== 0x05 || buf[1] !== 0x00) {
      process.stderr.write(`SOCKS5 connect failed: code=0x${buf[1].toString(16)}\n`);
      process.exit(1);
    }
    // 隧道已建立，后续直接转发
    const rest = buf.slice(buf.length);
    if (rest.length > 0) process.stdout.write(rest);
    socket.pipe(process.stdout);
    process.stdin.pipe(socket);
    phase = 'tunnel';
    return;
  }
});

socket.on('error', (e) => {
  process.stderr.write(`proxy socket error: ${e.message}\n`);
  process.exit(1);
});
process.stdin.on('error', () => process.exit(0));
process.stdout.on('error', () => process.exit(0));
