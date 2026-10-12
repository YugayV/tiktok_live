// Neural voices (Microsoft Edge "Read aloud" service via msedge-tts): free, many languages,
// far better than the 1–3 built-in Windows voices. Unofficial endpoint — if it fails, the
// caller falls back to the system voice.

const FORMAT = 'audio-24khz-48kbitrate-mono-mp3';

// Curated list shown in settings (ShortName → label). The full list can be loaded online.
export const NEURAL_VOICES = [
  ['ru-RU-SvetlanaNeural', 'Светлана — русский, женский'],
  ['ru-RU-DmitryNeural', 'Дмитрий — русский, мужской'],
  ['uk-UA-PolinaNeural', 'Поліна — украинский, женский'],
  ['uk-UA-OstapNeural', 'Остап — украинский, мужской'],
  ['kk-KZ-AigulNeural', 'Айгуль — казахский, женский'],
  ['kk-KZ-DauletNeural', 'Даулет — казахский, мужской'],
  ['uz-UZ-MadinaNeural', 'Madina — узбекский, женский'],
  ['en-US-AriaNeural', 'Aria — English (US), female'],
  ['en-US-GuyNeural', 'Guy — English (US), male'],
  ['en-GB-SoniaNeural', 'Sonia — English (UK), female'],
  ['de-DE-KatjaNeural', 'Katja — Deutsch, weiblich'],
  ['es-ES-ElviraNeural', 'Elvira — español, femenino'],
  ['tr-TR-EmelNeural', 'Emel — Türkçe, kadın'],
];

// Viewer text goes inside SSML: escape it so nobody can inject tags (voice changes, pauses, etc.).
export function escapeSsml(text) {
  return String(text).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]);
}

const pct = (n) => `${n >= 0 ? '+' : ''}${Math.round(n)}%`;

export class NeuralTTS {
  constructor({ loadLib = () => import('msedge-tts'), timeoutMs = 15000 } = {}) {
    this.loadLib = loadLib;
    this.timeoutMs = timeoutMs;
    this.chain = Promise.resolve();
  }

  // Returns an mp3 Buffer. Requests run one after another (the service dislikes bursts).
  synth(text, { voice = 'ru-RU-SvetlanaNeural', rate = 1, pitch = 0 } = {}) {
    const job = this.chain.then(() => this.run(text, { voice, rate, pitch }));
    this.chain = job.catch(() => {});
    return job;
  }

  async run(text, { voice, rate, pitch }) {
    const { MsEdgeTTS } = await this.loadLib();
    const tts = new MsEdgeTTS();
    let timer;
    try {
      await tts.setMetadata(voice, FORMAT);
      const { audioStream } = tts.toStream(escapeSsml(text), { rate: pct((Number(rate) || 1) * 100 - 100), pitch: pct(Number(pitch) || 0) });
      const chunks = [];
      await new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error('нейро-голос не ответил вовремя')), this.timeoutMs);
        audioStream.on('data', (c) => chunks.push(c));
        audioStream.on('end', resolve);
        audioStream.on('close', resolve);
        audioStream.on('error', reject);
      });
      const buf = Buffer.concat(chunks);
      if (buf.length < 500) throw new Error('пустой ответ сервиса озвучки');
      return buf;
    } finally {
      clearTimeout(timer);
      try {
        tts.close();
      } catch {}
    }
  }

  async voices() {
    const { MsEdgeTTS } = await this.loadLib();
    const list = await new MsEdgeTTS().getVoices();
    return list.map((v) => [v.ShortName, `${v.FriendlyName || v.ShortName}`]);
  }
}
