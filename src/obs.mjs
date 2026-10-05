// Minimal obs-websocket v5 client (OBS 28+): auth handshake + generic requests.

import { createHash, randomUUID } from 'node:crypto';
import WebSocket from 'ws';

const sha256b64 = (s) => createHash('sha256').update(s).digest('base64');

export function obsAuth(password, salt, challenge) {
  return sha256b64(sha256b64(password + salt) + challenge);
}

export class ObsClient {
  constructor() {
    this.ws = null;
    this.ready = false;
    this.pending = new Map();
  }

  connect(url, password = '') {
    this.close();
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      this.ws = ws;
      const fail = (err) => {
        this.ready = false;
        reject(err instanceof Error ? err : new Error(String(err)));
      };
      ws.on('error', fail);
      ws.on('close', () => {
        this.ready = false;
        for (const p of this.pending.values()) p.reject(new Error('OBS connection closed'));
        this.pending.clear();
      });
      ws.on('message', (buf) => {
        let msg;
        try {
          msg = JSON.parse(buf.toString());
        } catch {
          return;
        }
        if (msg.op === 0) {
          const auth = msg.d.authentication;
          const d = { rpcVersion: 1 };
          if (auth) d.authentication = obsAuth(password, auth.salt, auth.challenge);
          ws.send(JSON.stringify({ op: 1, d }));
        } else if (msg.op === 2) {
          this.ready = true;
          resolve();
        } else if (msg.op === 7) {
          const p = this.pending.get(msg.d.requestId);
          if (!p) return;
          this.pending.delete(msg.d.requestId);
          if (msg.d.requestStatus?.result) p.resolve(msg.d.responseData || {});
          else p.reject(new Error(msg.d.requestStatus?.comment || 'OBS request failed'));
        }
      });
    });
  }

  request(requestType, requestData = {}) {
    if (!this.ready) return Promise.reject(new Error('OBS не подключен'));
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject });
      this.ws.send(JSON.stringify({ op: 6, d: { requestType, requestId, requestData } }));
      setTimeout(() => {
        if (this.pending.delete(requestId)) reject(new Error('OBS timeout'));
      }, 5000);
    });
  }

  setScene(sceneName) {
    return this.request('SetCurrentProgramScene', { sceneName });
  }

  async setSourceVisible(sceneName, sourceName, visible) {
    const { sceneItemId } = await this.request('GetSceneItemId', { sceneName, sourceName });
    return this.request('SetSceneItemEnabled', { sceneName, sceneItemId, sceneItemEnabled: visible });
  }

  close() {
    this.ready = false;
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.on('error', () => {});
      this.ws.close();
    }
    this.ws = null;
  }
}
