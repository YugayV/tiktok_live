// Keyboard/mouse control for games: chat or gifts press keys on the streamer's PC.
// Steps run strictly one after another through a bounded queue, with a global
// rate limit and an emergency stop that releases every held key.

import { spawn } from 'node:child_process';

export const DEFAULT_KEYBOARD = { enabled: false, maxStepsPerSec: 8, maxQueue: 30, maxHoldMs: 10000 };

const ALIASES = {
  control: 'ctrl', ctl: 'ctrl', option: 'alt', return: 'enter', esc: 'escape', del: 'delete', ins: 'insert',
  pgup: 'pageup', pgdn: 'pagedown', arrowup: 'up', arrowdown: 'down', arrowleft: 'left', arrowright: 'right',
  '↑': 'up', '↓': 'down', '←': 'left', '→': 'right', cmd: 'win', command: 'win', super: 'win', meta: 'win',
  bksp: 'backspace', lclick: 'lmb', rclick: 'rmb', mclick: 'mmb', пробел: 'space',
};
const MODIFIERS = new Set(['ctrl', 'shift', 'alt', 'win']);

const VK = {
  backspace: 0x08, tab: 0x09, enter: 0x0d, shift: 0x10, ctrl: 0x11, alt: 0x12, escape: 0x1b, space: 0x20,
  pageup: 0x21, pagedown: 0x22, end: 0x23, home: 0x24, left: 0x25, up: 0x26, right: 0x27, down: 0x28,
  insert: 0x2d, delete: 0x2e, win: 0x5b, ';': 0xba, '=': 0xbb, ',': 0xbc, '-': 0xbd, '.': 0xbe, '/': 0xbf,
  '`': 0xc0, '[': 0xdb, '\\': 0xdc, ']': 0xdd, "'": 0xde,
};
for (let i = 0; i < 26; i++) VK[String.fromCharCode(97 + i)] = 0x41 + i;
for (let i = 0; i < 10; i++) {
  VK[String(i)] = 0x30 + i;
  VK[`num${i}`] = 0x60 + i;
}
for (let i = 1; i <= 12; i++) VK[`f${i}`] = 0x6f + i;
const MOUSE = { lmb: [0x02, 0x04], rmb: [0x08, 0x10], mmb: [0x20, 0x40] };

export function normalizeKey(name) {
  const k = String(name).trim().toLowerCase();
  const n = ALIASES[k] || k;
  return VK[n] !== undefined || MOUSE[n] ? n : null;
}

// "w"  "ctrl+shift+a"  "w, a, s"  → [["w"], ["ctrl","shift","a"], ...]; throws on unknown keys.
export function parseKeys(spec) {
  const steps = String(spec || '')
    .split(/[,\s]+/)
    .filter(Boolean)
    .map((combo) =>
      combo.split('+').filter(Boolean).map((k) => {
        const n = normalizeKey(k);
        if (!n) throw new Error(`Неизвестная клавиша: ${k}`);
        return n;
      }),
    );
  if (!steps.length) throw new Error('Не указаны клавиши');
  return steps;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class KeyController {
  constructor({ driver, getConfig = () => DEFAULT_KEYBOARD, sleepFn = sleep, now = () => Date.now() }) {
    this.driver = driver;
    this.getConfig = getConfig;
    this.sleep = sleepFn;
    this.now = now;
    this.queue = [];
    this.held = new Set();
    this.running = false;
    this.generation = 0;
    this.stepTimes = [];
  }

  // action: { keys, holdMs, repeat, intervalMs }. Returns number of steps queued.
  enqueue(action) {
    const cfg = this.getConfig();
    if (!cfg.enabled) return 0;
    const steps = parseKeys(action.keys);
    const repeat = Math.max(1, Math.min(20, Number(action.repeat) || 1));
    const hold = Math.max(20, Math.min(cfg.maxHoldMs || 10000, Number(action.holdMs) || 80));
    const gap = Math.max(0, Math.min(5000, Number(action.intervalMs) || 60));
    let added = 0;
    for (let r = 0; r < repeat; r++)
      for (const combo of steps) {
        if (this.queue.length >= (cfg.maxQueue || 30)) return added;
        this.queue.push({ combo, hold, gap });
        added++;
      }
    this.run();
    return added;
  }

  async run() {
    if (this.running) return;
    this.running = true;
    const gen = this.generation;
    try {
      while (this.queue.length && gen === this.generation) {
        await this.throttle();
        if (gen !== this.generation) break;
        const { combo, hold, gap } = this.queue.shift();
        for (const k of combo) {
          this.held.add(k);
          await this.driver.down(k);
        }
        await this.sleep(hold);
        for (const k of [...combo].reverse()) {
          if (!this.held.delete(k)) continue; // already released by stop()
          await this.driver.up(k);
        }
        await this.sleep(gap);
      }
    } finally {
      this.running = false;
      // Steps queued after an emergency stop belong to the new generation: keep going.
      if (gen !== this.generation && this.queue.length) this.run();
    }
  }

  async throttle() {
    const limit = this.getConfig().maxStepsPerSec || 8;
    for (;;) {
      const t = this.now();
      this.stepTimes = this.stepTimes.filter((x) => t - x < 1000);
      if (this.stepTimes.length < limit) break;
      await this.sleep(1000 - (t - this.stepTimes[0]) + 1);
    }
    this.stepTimes.push(this.now());
  }

  // Emergency stop: drop queued steps and release anything held down.
  async stop() {
    this.generation++;
    this.queue = [];
    const held = [...this.held];
    this.held.clear();
    for (const k of held) await this.driver.up(k);
  }

  snapshot() {
    return { queued: this.queue.length, held: [...this.held], driver: this.driver.name };
  }
}

// ---------------- OS drivers ----------------

const PS_SCRIPT = `
Add-Type @"
using System; using System.Runtime.InteropServices;
public static class TL {
  [StructLayout(LayoutKind.Sequential)] public struct KI { public ushort vk; public ushort scan; public uint flags; public uint time; public IntPtr extra; }
  [StructLayout(LayoutKind.Sequential)] public struct MI { public int dx; public int dy; public uint data; public uint flags; public uint time; public IntPtr extra; }
  [StructLayout(LayoutKind.Explicit)] public struct IN { [FieldOffset(0)] public uint type; [FieldOffset(8)] public KI ki; [FieldOffset(8)] public MI mi; }
  [DllImport("user32.dll")] static extern uint SendInput(uint n, IN[] i, int size);
  [DllImport("user32.dll")] static extern uint MapVirtualKey(uint code, uint type);
  public static void Key(ushort vk, bool up, bool ext) {
    var i = new IN(); i.type = 1; i.ki.scan = (ushort)MapVirtualKey(vk, 0);
    i.ki.flags = 0x0008u | (up ? 0x0002u : 0u) | (ext ? 0x0001u : 0u);
    SendInput(1, new IN[] { i }, Marshal.SizeOf(typeof(IN)));
  }
  public static void Mouse(uint flags) { var i = new IN(); i.type = 0; i.mi.flags = flags; SendInput(1, new IN[] { i }, Marshal.SizeOf(typeof(IN))); }
}
"@
while ($null -ne ($l = [Console]::In.ReadLine())) {
  $p = $l.Split(' ')
  if ($p[0] -eq 'm') { [TL]::Mouse([uint32]$p[1]) } else { [TL]::Key([uint16]$p[1], $p[0] -eq 'u', $p[2] -eq '1') }
}
`;
// Keys that need the "extended" flag when sent as scan codes (otherwise arrows act as numpad).
const EXTENDED = new Set(['left', 'up', 'right', 'down', 'insert', 'delete', 'home', 'end', 'pageup', 'pagedown', 'win']);

function windowsDriver() {
  let ps = null;
  const proc = () => {
    if (ps && ps.exitCode === null) return ps;
    ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', '-'], { stdio: ['pipe', 'ignore', 'inherit'], windowsHide: true });
    ps.stdin.write(PS_SCRIPT.replace(/\r?\n/g, '\r\n') + '\r\n');
    return ps;
  };
  const send = (line) => proc().stdin.write(line + '\r\n');
  return {
    name: 'windows-sendinput',
    down: (k) => (MOUSE[k] ? send(`m ${MOUSE[k][0]}`) : send(`d ${VK[k]} ${EXTENDED.has(k) ? 1 : 0}`)),
    up: (k) => (MOUSE[k] ? send(`m ${MOUSE[k][1]}`) : send(`u ${VK[k]} ${EXTENDED.has(k) ? 1 : 0}`)),
  };
}

const XDO = { enter: 'Return', escape: 'Escape', space: 'space', tab: 'Tab', backspace: 'BackSpace', left: 'Left', right: 'Right', up: 'Up', down: 'Down', insert: 'Insert', delete: 'Delete', home: 'Home', end: 'End', pageup: 'Prior', pagedown: 'Next', win: 'super', ';': 'semicolon', '=': 'equal', ',': 'comma', '-': 'minus', '.': 'period', '/': 'slash', '`': 'grave', '[': 'bracketleft', '\\': 'backslash', ']': 'bracketright', "'": 'apostrophe' };
const XMOUSE = { lmb: 1, mmb: 2, rmb: 3 };

function run(cmd, args) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { stdio: 'ignore' });
    p.on('error', () => resolve());
    p.on('exit', () => resolve());
  });
}

function linuxDriver() {
  const name = (k) => XDO[k] || (k.startsWith('num') ? `KP_${k.slice(3)}` : k.startsWith('f') && k.length > 1 ? k.toUpperCase() : k);
  return {
    name: 'linux-xdotool',
    down: (k) => (XMOUSE[k] ? run('xdotool', ['mousedown', String(XMOUSE[k])]) : run('xdotool', ['keydown', name(k)])),
    up: (k) => (XMOUSE[k] ? run('xdotool', ['mouseup', String(XMOUSE[k])]) : run('xdotool', ['keyup', name(k)])),
  };
}

// macOS System Events cannot hold ordinary keys, so the combo is tapped when released.
const MAC_CODES = { enter: 36, tab: 48, space: 49, backspace: 51, escape: 53, left: 123, right: 124, down: 125, up: 126, delete: 117, home: 115, end: 119, pageup: 116, pagedown: 121 };
const MAC_MODS = { ctrl: 'control down', shift: 'shift down', alt: 'option down', win: 'command down' };

function macDriver() {
  let mods = new Set();
  return {
    name: 'macos-osascript',
    down: (k) => {
      if (MODIFIERS.has(k)) mods.add(k);
    },
    up: (k) => {
      if (MODIFIERS.has(k)) return void mods.delete(k);
      if (MOUSE[k]) return; // no mouse support without native helpers
      const using = mods.size ? ` using {${[...mods].map((m) => MAC_MODS[m]).join(', ')}}` : '';
      const press = MAC_CODES[k] !== undefined ? `key code ${MAC_CODES[k]}` : `keystroke "${k.replace(/["\\]/g, '\\$&')}"`;
      return run('osascript', ['-e', `tell application "System Events" to ${press}${using}`]);
    },
  };
}

export function createOsDriver(platform = process.platform) {
  if (platform === 'win32') return windowsDriver();
  if (platform === 'darwin') return macDriver();
  return linuxDriver();
}
