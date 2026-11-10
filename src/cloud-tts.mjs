// Neural voices through official cloud APIs, with the streamer's own key:
//  - Microsoft Azure Speech: the same Svetlana / Dmitry voices as Edge; free tier 500k chars/month.
//  - Yandex SpeechKit: natural Russian voices (alena, filipp, ermil, jane…).
// Returns an mp3 Buffer; the caller falls back to the system voice on any error.

export const AZURE_VOICES = [
  ['ru-RU-SvetlanaNeural', 'Светлана — русский, женский'],
  ['ru-RU-DariyaNeural', 'Дария — русский, женский'],
  ['ru-RU-DmitryNeural', 'Дмитрий — русский, мужской'],
  ['uk-UA-PolinaNeural', 'Поліна — украинский, женский'],
  ['uk-UA-OstapNeural', 'Остап — украинский, мужской'],
  ['kk-KZ-AigulNeural', 'Айгуль — казахский, женский'],
  ['kk-KZ-DauletNeural', 'Даулет — казахский, мужской'],
  ['uz-UZ-MadinaNeural', 'Madina — узбекский, женский'],
  ['uz-UZ-SardorNeural', 'Sardor — узбекский, мужской'],
  ['en-US-AriaNeural', 'Aria — English (US), female'],
  ['en-US-GuyNeural', 'Guy — English (US), male'],
  ['de-DE-KatjaNeural', 'Katja — Deutsch, weiblich'],
  ['tr-TR-EmelNeural', 'Emel — Türkçe, kadın'],
];

export const YANDEX_VOICES = [
  ['alena', 'Алёна — женский'],
  ['jane', 'Джейн — женский'],
  ['omazh', 'Омаж — женский'],
  ['filipp', 'Филипп — мужской'],
  ['ermil', 'Ермил — мужской'],
  ['zahar', 'Захар — мужской'],
  ['madirus', 'Мадирус — мужской'],
];

// Viewer text goes inside SSML: escape it so nobody can inject tags.
export function escapeSsml(text) {
  return String(text).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]);
}

const pct = (n) => `${n >= 0 ? '+' : ''}${Math.round(n)}%`;

// Error text the streamer can act on.
function httpError(provider, status, body) {
  const hint =
    status === 401 || status === 403
      ? 'ключ неверный или не подходит к региону'
      : status === 429
        ? 'превышен лимит запросов или бесплатный лимит месяца'
        : status === 400
          ? 'сервис не принял запрос (проверьте голос и регион)'
          : `ошибка сервиса ${status}`;
  return new Error(`${provider}: ${hint}${body ? ` — ${String(body).slice(0, 120)}` : ''}`);
}

export class CloudTTS {
  constructor({ fetchImpl = globalThis.fetch, timeoutMs = 15000 } = {}) {
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  async synth(text, cfg) {
    if (cfg.engine === 'azure') return this.azure(text, cfg);
    if (cfg.engine === 'yandex') return this.yandex(text, cfg);
    throw new Error(`неизвестный движок ${cfg.engine}`);
  }

  async request(provider, url, init) {
    let res;
    try {
      res = await this.fetch(url, { ...init, signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (err) {
      throw new Error(`${provider}: нет связи с сервисом (${err.name === 'TimeoutError' ? 'не ответил вовремя' : err.message})`);
    }
    if (!res.ok) throw httpError(provider, res.status, await res.text().catch(() => ''));
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 200) throw new Error(`${provider}: пустой ответ`);
    return buf;
  }

  azure(text, { azureKey, azureRegion, azureVoice = 'ru-RU-SvetlanaNeural', rate = 1, pitch = 0 }) {
    if (!azureKey || !azureRegion) throw new Error('Azure: укажите ключ и регион в настройках озвучки');
    const region = String(azureRegion).trim().toLowerCase();
    if (!/^[a-z0-9]+$/.test(region)) throw new Error('Azure: регион пишется как westeurope, eastus…');
    const voice = String(azureVoice).replace(/[^\w-]/g, '');
    const lang = voice.split('-').slice(0, 2).join('-');
    const ssml = `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="${lang}"><voice name="${voice}"><prosody rate="${pct((Number(rate) || 1) * 100 - 100)}" pitch="${pct(Number(pitch) || 0)}">${escapeSsml(text)}</prosody></voice></speak>`;
    return this.request('Azure', `https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`, {
      method: 'POST',
      headers: {
        'Ocp-Apim-Subscription-Key': String(azureKey).trim(),
        'Content-Type': 'application/ssml+xml',
        'X-Microsoft-OutputFormat': 'audio-24khz-48kbitrate-mono-mp3',
        'User-Agent': 'TikLiveStudio',
      },
      body: ssml,
    });
  }

  yandex(text, { yandexKey, yandexVoice = 'alena', rate = 1 }) {
    if (!yandexKey) throw new Error('Яндекс: укажите API-ключ в настройках озвучки');
    const voice = String(yandexVoice).replace(/[^\w]/g, '');
    const speed = Math.max(0.1, Math.min(3, Number(rate) || 1));
    const body = new URLSearchParams({ text: String(text), lang: 'ru-RU', voice, speed: String(speed), format: 'mp3' });
    return this.request('Яндекс', 'https://tts.api.cloud.yandex.net/speech/v1/tts:synthesize', {
      method: 'POST',
      headers: { Authorization: `Api-Key ${String(yandexKey).trim()}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
  }
}
