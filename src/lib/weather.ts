import AsyncStorage from '@react-native-async-storage/async-storage';

// 天气小组件的数据层：全部使用免密钥公开接口。
//
// 实测（2026-11-17）单一供应商都会挂，所以这里做成了「链式降级 + 冷却 + 缓存」：
//   · 定位：ipwho.is（快）→ ipinfo.io（稳）→ 上次缓存
//   · 天气：open-meteo（1s，当前气温，但常被墙）→ wttr.in（4s，可达性好）→ 上次缓存
//   · 注意：7timer 用 node 探针 200/2.5s，但浏览器里被 CORS 挡（TypeError: Failed to fetch），
//     所以「能不能通」必须用页面上下文验证，node 探针只能证明网络可达
//   · 任何一步全失败都返回 null，界面降级成「天气不可用」，绝不影响首页其它内容

const LOCATION_CACHE_KEY = 'weather.coarse-location.v1';
const WEATHER_CACHE_KEY = 'weather.snapshot.v1';
const COOLDOWN_KEY = 'weather.provider-cooldown.v1';

const LOCATION_TTL_MS = 12 * 60 * 60 * 1000;
const WEATHER_TTL_MS = 30 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 7000;
const COOLDOWN_MS = 60 * 60 * 1000;

export type WeatherInfo = {
  tempC: number;
  text: string;
  icon: 'sunny' | 'cloud' | 'rain' | 'snow' | 'thunder' | 'fog';
  city: string | null;
};

type CoarseLocation = { latitude: number; longitude: number; city: string | null; savedAt: number };

type Fetched = { status: number; data: unknown };

// 超时必须覆盖到响应体解析：只包住 fetch 本身时，服务端在响应体阶段卡住会一直挂起
async function fetchJsonWithTimeout(url: string, timeoutMs = REQUEST_TIMEOUT_MS): Promise<Fetched | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) return { status: response.status, data: null };
    return { status: response.status, data: (await response.json()) as unknown };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ---------- 冷却：被限流/超时的供应商一段时间内不再尝试 ----------

async function loadCooldowns(): Promise<Record<string, number>> {
  try {
    const raw = await AsyncStorage.getItem(COOLDOWN_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, number>;
    const now = Date.now();
    const alive: Record<string, number> = {};
    for (const [name, until] of Object.entries(parsed)) {
      if (typeof until === 'number' && until > now) alive[name] = until;
    }
    return alive;
  } catch {
    return {};
  }
}

async function setCooldown(name: string, durationMs = COOLDOWN_MS) {
  try {
    const cooldowns = await loadCooldowns();
    cooldowns[name] = Date.now() + durationMs;
    await AsyncStorage.setItem(COOLDOWN_KEY, JSON.stringify(cooldowns));
  } catch {
    // 冷却只是优化，写不进去也无所谓
  }
}

// ---------- 定位 ----------

function toNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

const LOCATION_PROVIDERS: Array<{
  name: string;
  url: string;
  parse: (data: unknown) => CoarseLocation | null;
}> = [
  {
    name: 'ipwho.is',
    url: 'https://ipwho.is/',
    parse: (data) => {
      const d = data as { success?: boolean; latitude?: unknown; longitude?: unknown; city?: unknown };
      if (!d || d.success === false) return null;
      const latitude = toNumber(d.latitude);
      const longitude = toNumber(d.longitude);
      if (latitude === null || longitude === null) return null;
      return { latitude, longitude, city: typeof d.city === 'string' ? d.city : null, savedAt: Date.now() };
    },
  },
  {
    name: 'ipinfo.io',
    url: 'https://ipinfo.io/json',
    parse: (data) => {
      const d = data as { loc?: unknown; city?: unknown };
      if (!d || typeof d.loc !== 'string') return null;
      const [latText, lonText] = d.loc.split(',');
      const latitude = Number(latText);
      const longitude = Number(lonText);
      if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
      return { latitude, longitude, city: typeof d.city === 'string' ? d.city : null, savedAt: Date.now() };
    },
  },
];

/** 免密钥 IP 粗定位；先看缓存，再按链路逐个试，全失败回退过期缓存。 */
async function getCoarseLocation(): Promise<CoarseLocation | null> {
  let stale: CoarseLocation | null = null;
  try {
    const cachedRaw = await AsyncStorage.getItem(LOCATION_CACHE_KEY);
    if (cachedRaw) {
      const cached = JSON.parse(cachedRaw) as CoarseLocation;
      if (typeof cached.latitude === 'number' && typeof cached.longitude === 'number') {
        if (Date.now() - cached.savedAt < LOCATION_TTL_MS) return cached;
        stale = cached;
      }
    }
  } catch {
    // 缓存损坏时忽略，继续走网络
  }

  const cooldowns = await loadCooldowns();
  for (const provider of LOCATION_PROVIDERS) {
    if (cooldowns[provider.name]) continue;
    const fetched = await fetchJsonWithTimeout(provider.url);
    if (!fetched) {
      // 连不上：给一个短冷却，避免每个页面都重试一遍
      await setCooldown(provider.name);
      continue;
    }
    if (fetched.status === 429 || fetched.status >= 500) {
      await setCooldown(provider.name);
      continue;
    }
    const location = provider.parse(fetched.data);
    if (!location) continue;
    await AsyncStorage.setItem(LOCATION_CACHE_KEY, JSON.stringify(location)).catch(() => {});
    return location;
  }

  return stale;
}

// ---------- 天气 ----------

function describeWmo(code: number): { text: string; icon: WeatherInfo['icon'] } {
  if (code === 0) return { text: '晴', icon: 'sunny' };
  if (code === 1) return { text: '大致晴朗', icon: 'sunny' };
  if (code === 2) return { text: '多云', icon: 'cloud' };
  if (code === 3) return { text: '阴', icon: 'cloud' };
  if (code === 45 || code === 48) return { text: '有雾', icon: 'fog' };
  if (code >= 51 && code <= 57) return { text: '毛毛雨', icon: 'rain' };
  if (code >= 61 && code <= 67) return { text: '下雨', icon: 'rain' };
  if (code >= 71 && code <= 77) return { text: '下雪', icon: 'snow' };
  if (code >= 80 && code <= 82) return { text: '阵雨', icon: 'rain' };
  if (code === 85 || code === 86) return { text: '阵雪', icon: 'snow' };
  if (code >= 95) return { text: '雷雨', icon: 'thunder' };
  return { text: '天气', icon: 'cloud' };
}

/** wttr.in 返回的是 WWO 天气码 + 中文描述，用关键词兜底映射图标。 */
function describeWttr(text: string, code: number): { text: string; icon: WeatherInfo['icon'] } {
  const lowered = text.toLowerCase();
  if (lowered.includes('thunder') || /雷/.test(text) || code === 200) return { text: '雷雨', icon: 'thunder' };
  if (lowered.includes('snow') || /雪/.test(text) || (code >= 227 && code <= 230) || (code >= 323 && code <= 395)) {
    return { text: '下雪', icon: 'snow' };
  }
  if (lowered.includes('rain') || lowered.includes('drizzle') || /雨/.test(text) || (code >= 293 && code <= 321)) {
    return { text: '下雨', icon: 'rain' };
  }
  if (lowered.includes('fog') || lowered.includes('mist') || lowered.includes('haze') || /雾|霾/.test(text)) {
    return { text: '有雾', icon: 'fog' };
  }
  if (lowered.includes('sunny') || /晴/.test(text)) return { text: '晴', icon: 'sunny' };
  if (lowered.includes('cloud') || lowered.includes('overcast') || /云|阴/.test(text)) return { text: '多云', icon: 'cloud' };
  return { text: '天气', icon: 'cloud' };
}

async function fetchFromOpenMeteo(location: CoarseLocation): Promise<WeatherInfo | null> {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${location.latitude}&longitude=${location.longitude}&current=temperature_2m,weather_code&timezone=auto`;
  const fetched = await fetchJsonWithTimeout(url);
  if (!fetched || !fetched.data) return null;
  const current = (fetched.data as { current?: { temperature_2m?: unknown; weather_code?: unknown } }).current;
  const tempC = toNumber(current?.temperature_2m);
  const code = toNumber(current?.weather_code);
  if (tempC === null || code === null) return null;
  const { text, icon } = describeWmo(code);
  return { tempC: Math.round(tempC), text, icon, city: location.city };
}

async function fetchFromWttr(location: CoarseLocation): Promise<WeatherInfo | null> {
  const url = `https://wttr.in/${location.latitude.toFixed(3)},${location.longitude.toFixed(3)}?format=j1`;
  const fetched = await fetchJsonWithTimeout(url, 9000);
  if (!fetched || !fetched.data) return null;
  const current = (fetched.data as {
    current_condition?: Array<{
      temp_C?: unknown;
      weatherCode?: unknown;
      weatherDesc?: Array<{ value?: unknown }>;
      lang_zh?: Array<{ value?: unknown }>;
    }>;
    nearest_area?: Array<{ areaName?: Array<{ value?: unknown }> }>;
  }).current_condition?.[0];
  const tempC = toNumber(current?.temp_C);
  if (tempC === null) return null;
  const code = toNumber(current?.weatherCode) ?? 0;
  const zh = current?.lang_zh?.[0]?.value;
  const desc = current?.weatherDesc?.[0]?.value;
  const label = typeof zh === 'string' && zh.trim() && zh.trim().toLowerCase() !== desc ? zh : String(desc ?? '');
  const { text, icon } = describeWttr(label, code);
  const area = (fetched.data as { nearest_area?: Array<{ areaName?: Array<{ value?: unknown }> }> }).nearest_area?.[0]
    ?.areaName?.[0]?.value;
  return {
    tempC: Math.round(tempC),
    text,
    icon,
    city: location.city ?? (typeof area === 'string' ? area : null),
  };
}

const WEATHER_PROVIDERS: Array<{ name: string; run: (location: CoarseLocation) => Promise<WeatherInfo | null> }> = [
  { name: 'open-meteo', run: fetchFromOpenMeteo },
  { name: 'wttr.in', run: fetchFromWttr },
];

// 网络类失败给 20 分钟冷却就够（线路抖动通常几分钟自愈），429 才按 1 小时算
const WEATHER_FAILURE_COOLDOWN_MS = 20 * 60 * 1000;

type WeatherSnapshot = { info: WeatherInfo; savedAt: number };

export async function fetchWeather(): Promise<WeatherInfo | null> {
  try {
    const raw = await AsyncStorage.getItem(WEATHER_CACHE_KEY);
    if (raw) {
      const cached = JSON.parse(raw) as WeatherSnapshot;
      if (cached?.info && Date.now() - cached.savedAt < WEATHER_TTL_MS) return cached.info;
    }
  } catch {
    // 缓存坏了就走网络
  }

  const location = await getCoarseLocation();
  if (!location) return null;

  const cooldowns = await loadCooldowns();
  // 三个供应商全都在冷却里时，如果连旧快照都没有，就无视冷却试第一个可用的
  // （否则用户会一整天盯着「天气不可用」，而供应商其实早就恢复了）
  const allCooling = WEATHER_PROVIDERS.every((provider) => cooldowns[provider.name]);
  const hasSnapshot = await AsyncStorage.getItem(WEATHER_CACHE_KEY);
  const allowRetry = allCooling && !hasSnapshot;

  for (const provider of WEATHER_PROVIDERS) {
    if (cooldowns[provider.name] && !allowRetry) continue;
    const info = await provider.run(location);
    if (info) {
      await AsyncStorage.setItem(WEATHER_CACHE_KEY, JSON.stringify({ info, savedAt: Date.now() })).catch(() => {});
      return info;
    }
    // 供应商失败就先冷却，别让每个页面都白等 7-8 秒
    await setCooldown(provider.name, WEATHER_FAILURE_COOLDOWN_MS);
  }

  try {
    const raw = await AsyncStorage.getItem(WEATHER_CACHE_KEY);
    if (raw) {
      const cached = JSON.parse(raw) as WeatherSnapshot;
      if (cached?.info) return cached.info;
    }
  } catch {
    // 忽略
  }
  return null;
}
