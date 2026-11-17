import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL;
const supabaseAnonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error('缺少 EXPO_PUBLIC_SUPABASE_URL 或 EXPO_PUBLIC_SUPABASE_ANON_KEY，请检查根目录 .env');
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    storage: AsyncStorage,
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: false,
  },
});

// 安装级设备标识：只用于 Edge Function 的设备维度限流，避免共享 WiFi / NAT 下多个用户被合并计数。
const DEVICE_ID_STORAGE_KEY = 'device-id';
let deviceIdPromise: Promise<string> | null = null;

function createDeviceId() {
  const bytes = new Uint8Array(16);
  const webCrypto = globalThis.crypto;
  if (webCrypto && typeof webCrypto.getRandomValues === 'function') {
    webCrypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i += 1) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

export async function getDeviceId(): Promise<string> {
  if (!deviceIdPromise) {
    deviceIdPromise = (async () => {
      try {
        const stored = await AsyncStorage.getItem(DEVICE_ID_STORAGE_KEY);
        if (stored) return stored;
        const created = createDeviceId();
        await AsyncStorage.setItem(DEVICE_ID_STORAGE_KEY, created);
        return created;
      } catch {
        // 存储不可用时退化为临时 ID：仅本次运行有效，限流会回落到 IP 维度。
        return createDeviceId();
      }
    })();
  }
  return deviceIdPromise;
}

// ---------- 网络健壮性 ----------
// 国内访问 Supabase 会间歇性出现 TypeError: Failed to fetch（TLS 被重置），
// 而 supabase-js 默认既不重试也没有超时，页面会永远停在骨架屏。
// 这里统一加「超时 + 指数退避重试」，只有网络层错误才重试，业务错误直接抛。

// 单次查询 6.5 秒、最多 2 次尝试（合计约 13 秒）是体验上的上限：
// 再长用户就会以为界面卡死，而国内到 Supabase 的抖动通常是几秒内自愈。
const QUERY_TIMEOUT_MS = 6_500;

export class NetworkError extends Error {
  constructor(message = '网络不稳定，请检查网络后重试') {
    super(message);
    this.name = 'NetworkError';
  }
}

function isNetworkError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error ?? '');
  return /Failed to fetch|Network request failed|network ?error|ECONNRESET|ETIMEDOUT|Load failed|aborted/i.test(message);
}

async function withTimeout<T>(work: PromiseLike<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve(work),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new NetworkError('请求超时，请重试')), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * 上传重试：移动网络下 Storage 上传偶发超时，重试一次能救回大部分失败。
 * 第二次用 upsert 覆盖同一路径——字节完全一样，覆盖是幂等的，也不会串到别人的文件上。
 */
export async function uploadWithRetry(
  bucket: string,
  path: string,
  bytes: ArrayBuffer,
  contentType: string,
): Promise<void> {
  let lastMessage = '';
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const { error } = await supabase.storage.from(bucket).upload(path, bytes, {
      contentType,
      upsert: attempt > 0,
    });
    if (!error) return;
    lastMessage = error.message;
    // 只有网络类错误值得重试；权限、格式、体积这类错误重试也不会变好
    if (!isNetworkError(error) && !/timeout|timed out|超时/i.test(error.message)) break;
    await new Promise((resolve) => setTimeout(resolve, 1200));
  }
  throw new Error(lastMessage || '上传失败，请重试');
}

async function withRetry<T>(work: () => Promise<T>, attempts = 2): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await withTimeout(work(), QUERY_TIMEOUT_MS);
    } catch (error) {
      lastError = error;
      if (!isNetworkError(error) && !(error instanceof NetworkError)) throw error;
      if (attempt < attempts - 1) {
        await new Promise((resolve) => setTimeout(resolve, 600 * 2 ** attempt));
      }
    }
  }
  throw lastError instanceof Error ? lastError : new NetworkError();
}

// ---- 私有存储的访问票据 ----
//
// 用户全身照从 2026-11-16 起写进私有桶 `user-media`（`016_storage_private_buckets.sql`）：
// 库里存的仍然是「规范形式」的 URL（`/object/public/<bucket>/<path>`，不含会过期的 token），
// 真正要显示、或者要交给外部服务下载之前，再用 createSignedUrl 换一张 1 小时有效的临时票。
// 老桶 `user-photos` 仍保持 public（里面还有历史商品平铺图，供应商要直接下载）。
//
// 这样做的好处是数据库里没有会过期的字符串，换桶、换域名、改签名时长都不用刷数据。
// user-photos 里还留着历史照片，等 017 把它也改成私有桶之后，这份名单不用再动：
// 现在提前放进来，签名对公开桶同样有效（已实测），切换那一刻就没有空窗。
export const PRIVATE_BUCKETS = new Set<string>(['user-media', 'user-photos', 'tryon-results']);

type StorageRef = { bucket: string; path: string };

/** 从任意形式的 Storage URL 里取出 `{bucket, path}`；签过名的 URL 也能解析（token 会被丢掉）。 */
export function parseStorageUrl(url: string): StorageRef | null {
  if (!url) return null;
  const match = url.match(/\/storage\/v1\/object\/(?:public|sign|authenticated)\/([^/?#]+)\/([^?#]+)/);
  if (!match) return null;
  return { bucket: decodeURIComponent(match[1]), path: decodeURIComponent(match[2]) };
}

/** 把签过名的 URL 还原成不带 token 的规范地址，方便存库和去重。 */
export function canonicalStorageUrl(url: string): string {
  const ref = parseStorageUrl(url);
  if (!ref) return url;
  return supabase.storage.from(ref.bucket).getPublicUrl(ref.path).data.publicUrl;
}

const SIGNED_TTL_SECONDS = 3600;
// 提前 5 分钟续签，避免「刚好在渲染那一刻过期」导致的偶发裂图
const SIGNED_REFRESH_MARGIN_MS = 5 * 60 * 1000;
const signedUrlCache = new Map<string, { url: string; expiresAt: number }>();
const signedUrlInflight = new Map<string, Promise<string>>();

function signedCacheKey(ref: StorageRef) {
  return `${ref.bucket}/${ref.path}`;
}

/**
 * 取一个可访问的 URL：公共桶原样返回，私有桶换成 1 小时有效的签名地址。
 * 同一张图在有效期内只签一次；并发请求共用同一个 promise。
 */
export async function signStorageUrl(url: string): Promise<string> {
  const ref = parseStorageUrl(url);
  if (!ref || !PRIVATE_BUCKETS.has(ref.bucket)) return url;
  const key = signedCacheKey(ref);
  const cached = signedUrlCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.url;
  const pending = signedUrlInflight.get(key);
  if (pending) return pending;

  const job = (async () => {
    const { data, error } = await supabase.storage.from(ref.bucket).createSignedUrl(ref.path, SIGNED_TTL_SECONDS);
    if (error || !data?.signedUrl) throw error ?? new Error('生成访问链接失败');
    signedUrlCache.set(key, {
      url: data.signedUrl,
      expiresAt: Date.now() + SIGNED_TTL_SECONDS * 1000 - SIGNED_REFRESH_MARGIN_MS,
    });
    return data.signedUrl;
  })();
  signedUrlInflight.set(key, job);
  try {
    return await job;
  } finally {
    signedUrlInflight.delete(key);
  }
}

/** 显示用：签名失败就退回原地址（宁可裂一张图，也不要把整页搞崩）。 */
export async function resolveDisplayUrl(url: string | null | undefined): Promise<string | null> {
  if (!url) return url ?? null;
  try {
    return await signStorageUrl(url);
  } catch {
    return url;
  }
}

/** 列表用：同一桶的图一次签完（createSignedUrls 支持批量），比逐张签少一堆请求。 */
export async function resolveDisplayUrls(urls: (string | null | undefined)[]): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  const groups = new Map<string, string[]>();
  const attempts = new Map<string, string>();
  for (const url of urls) {
    if (!url) continue;
    const ref = parseStorageUrl(url);
    if (!ref || !PRIVATE_BUCKETS.has(ref.bucket)) {
      result.set(url, url);
      continue;
    }
    attempts.set(signedCacheKey(ref), url);
    const list = groups.get(ref.bucket) ?? [];
    list.push(ref.path);
    groups.set(ref.bucket, list);
  }

  await Promise.all(
    [...groups.entries()].map(async ([bucket, paths]) => {
      const { data, error } = await supabase.storage.from(bucket).createSignedUrls(paths, SIGNED_TTL_SECONDS);
      if (error || !data) return;
      const expiresAt = Date.now() + SIGNED_TTL_SECONDS * 1000 - SIGNED_REFRESH_MARGIN_MS;
      for (const item of data) {
        if (!item.signedUrl || !item.path) continue;
        const key = `${bucket}/${item.path}`;
        signedUrlCache.set(key, { url: item.signedUrl, expiresAt });
        const original = attempts.get(key);
        if (original) result.set(original, item.signedUrl);
      }
    }),
  );

  // 批量失败的漏网之鱼逐张补签，保证能不裂就不裂
  await Promise.all(
    [...attempts.entries()].map(async ([key, original]) => {
      if (result.has(original)) return;
      const signed = await resolveDisplayUrl(original).catch(() => null);
      if (signed) result.set(original, signed);
    }),
  );
  return result;
}

export type Garment = {
  id: string;
  name: string;
  category: string;
  color: string | null;
  flat_image_url: string;
  model_image_url: string | null;
  /** 背面平铺图（021 迁移）。老库没有这一列时是 undefined，前端据此隐藏「看背面」 */
  back_image_url?: string | null;
  gender: string;
  created_at: string;
};

const BASE_GARMENT_FIELDS = ['id', 'name', 'category', 'color', 'flat_image_url', 'model_image_url', 'gender', 'created_at'];
// 021 迁移加的列：没应用时 select 它会直接报 42703，所以按需拼进字段列表并做一次降级
let backImageSupported = true;

// 软删除（013 迁移）之后下架的单品不再出现在前端；但迁移没应用时不能直接带过滤条件，
// 否则 PostgREST 会报 "column garments.archived_at does not exist" 让整个衣橱变空。
// 这里探测一次：出错就永久降级为不带过滤，保证新旧数据库都能跑。
let archivedFilterSupported = true;

// 返回类型显式标注：字段列表是动态拼的，supabase-js 推不出字面量类型，只能自己断言
async function selectGarments(): Promise<Garment[]> {
  const fields = [...BASE_GARMENT_FIELDS, ...(backImageSupported ? ['back_image_url'] : [])].join(',');
  let query = supabase
    .from('garments')
    .select(fields)
    .order('created_at', { ascending: false });
  if (archivedFilterSupported) query = query.is('archived_at', null);

  const { data, error } = await query;
  if (error) {
    // 两个可选列分别探测一次，谁缺就永久降级谁，保证新旧数据库都能跑
    if (backImageSupported && /back_image_url/i.test(error.message)) {
      backImageSupported = false;
      return selectGarments();
    }
    if (archivedFilterSupported && /archived_at/i.test(error.message)) {
      archivedFilterSupported = false;
      return selectGarments();
    }
    throw new Error(error.message);
  }
  return (data ?? []) as unknown as Garment[];
}

export async function fetchGarments(): Promise<Garment[]> {
  return withRetry(selectGarments);
}

export type HomeInspiration = {
  id: string;
  garmentId: string | null;
  kind: 'video' | 'image' | 'garment';
  title: string;
  subtitle: string;
  uri: string;
  videoUrl?: string;
};

export type HomeFeedResult = {
  items: HomeInspiration[];
  /** 非致命问题（例如灵感流读取失败后回退到单品），供界面做轻提示 */
  warning: string | null;
};

// 015 迁移后灵感帖会带上 garment_id，没应用的库退回旧字段列表，不影响读取
type InspirationRow = {
  id: string;
  caption: string | null;
  media_type: string;
  media_url: string;
  garment_id?: string | null;
};

let garmentLinkSupported = true;

// 字段列表是动态拼的，supabase-js 的字符串字面量解析器推断不出类型，这里统一收口一次
async function selectInspirationPosts(): Promise<InspirationRow[]> {
  const fields = garmentLinkSupported
    ? 'id,caption,media_type,media_url,created_at,owner_id,garment_id'
    : 'id,caption,media_type,media_url,created_at,owner_id';
  const result = (await supabase
    .from('inspiration_posts')
    .select(fields)
    .order('created_at', { ascending: false })
    .limit(100)) as unknown as { data: InspirationRow[] | null; error: { message: string } | null };
  if (result.error && garmentLinkSupported && /garment_id/i.test(result.error.message)) {
    garmentLinkSupported = false;
    return selectInspirationPosts();
  }
  if (result.error) throw new Error(result.error.message);
  return result.data ?? [];
}

export async function fetchHomeInspiration(): Promise<HomeFeedResult> {
  try {
    const rows = await withRetry(selectInspirationPosts);

    if (rows.length) {
      const community: HomeInspiration[] = rows.map((row) => {
        const mediaType = row.media_type;
        const linkedGarmentId = row.garment_id ?? null;
        return {
          id: row.id,
          garmentId: linkedGarmentId,
          kind: mediaType === 'video' ? ('video' as const) : ('image' as const),
          title: row.caption || (mediaType === 'video' ? '穿搭短视频' : '穿搭灵感'),
          subtitle: linkedGarmentId
            ? '社区发布 · 可试穿'
            : mediaType === 'video'
              ? '社区发布 · 视频'
              : '社区发布 · 图片',
          uri: row.media_url,
          ...(mediaType === 'video' ? { videoUrl: row.media_url } : {}),
        };
      });

      // 社区内容太少时首页会显得空旷（刚上线只有 2 条），用单品灵感补到 6 条。
      // 补的内容一律排在社区内容之后，不打乱「人发的在前」这个顺序。
      const FILL_TO = 6;
      if (community.length < FILL_TO) {
        const garments = await fetchGarments().catch(() => [] as Garment[]);
        const usedGarmentIds = new Set(
          community.map((item) => item.garmentId).filter((id): id is string => Boolean(id)),
        );
        const fillers = garments
          .filter((garment) => !usedGarmentIds.has(garment.id))
          .slice(0, FILL_TO - community.length)
          .map(toGarmentInspiration);
        return { items: [...community, ...fillers], warning: null };
      }

      return { items: community, warning: null };
    }
  } catch {
    // 灵感流读取失败仍然回退到衣服素材，但把失败原因透出，避免「静默吞错」
    const garments = await fetchGarments().catch(() => [] as Garment[]);
    return {
      items: garments.slice(0, 8).map(toGarmentInspiration),
      warning: '社区灵感暂时读取失败，先为你展示单品灵感',
    };
  }

  const garments = await fetchGarments();
  return { items: garments.slice(0, 8).map(toGarmentInspiration), warning: null };
}

function toGarmentInspiration(garment: Garment): HomeInspiration {
  return {
    id: `garment-${garment.id}`,
    garmentId: garment.id,
    kind: 'garment' as const,
    title: garment.name,
    subtitle: `${garment.category} · 单品灵感`,
    uri: garment.model_image_url || garment.flat_image_url,
  };
}

export type TryonTask = {
  garment_id?: string | null;
  id: string;
  user_photo_url: string | null;
  status: 'pending' | 'processing' | 'done' | 'failed' | 'timeout';
  stage?: 'tryon' | 'video';
  output_type?: 'image' | 'video';
  pose_id?: string | null;
  first_frame_url: string | null;
  result_url: string | null;
  error_msg: string | null;
  created_at: string;
};

async function withDisplayUrls<T extends TryonTask>(task: T): Promise<T> {
  const signed = await resolveDisplayUrls([task.user_photo_url, task.first_frame_url, task.result_url]);
  return withSignedMedia(task, signed);
}

function withSignedMedia<T extends TryonTask>(task: T, signed: Map<string, string>): T {
  const pick = (url: string | null) => (url ? signed.get(url) ?? url : null);
  return {
    ...task,
    user_photo_url: pick(task.user_photo_url),
    first_frame_url: pick(task.first_frame_url),
    result_url: pick(task.result_url),
  };
}

export type Pose = {
  id: string;
  name: string;
  pose_desc: string | null;
  image_url: string | null;
  gender: string;
};

type FunctionInvokeError = Error & { context?: unknown };

export async function getFunctionErrorMessage(error: FunctionInvokeError) {
  const context = error.context;
  if (context instanceof Response) {
    const responseText = await context.clone().text().catch(() => '');
    let payload: { error?: string; details?: string; provider_status?: number; garment_id?: string } = {};
    try {
      payload = JSON.parse(responseText) as typeof payload;
    } catch {
      // Some Edge Function failures return plain text instead of JSON.
    }

    const message = payload.error || responseText || error.message;
    const detail = payload.details ? `：${payload.details}` : '';
    const garmentId = payload.garment_id ? `（衣服 ID ${payload.garment_id}）` : '';
    const providerStatus = payload.provider_status ? `（服务商状态 ${payload.provider_status}）` : '';
    return `${message}${detail}${garmentId}${providerStatus}（HTTP ${context.status}）`;
  }
  return error.message;
}

// Edge Function 请求头：带当前会话的 JWT（没有会话时退回 anon key）。
// tryon / video 用它绑定任务归属，GET 轮询也用它做归属校验。
async function buildEdgeHeaders(): Promise<Record<string, string>> {
  const key = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
  if (!key) throw new Error('缺少 Supabase 配置');
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token ?? key;
  return { apikey: key, Authorization: `Bearer ${token}` };
}

// 轮询用的 fetch 必须自带超时：否则网关挂起时 Promise 永不 settle，
// 试衣按钮会一直处于 generating 状态，页面里的 15 分钟兜底永远等不到。
const EDGE_TIMEOUT_MS = 15_000;

async function fetchEdge(input: string, init: RequestInit = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), EDGE_TIMEOUT_MS);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new NetworkError('网络请求超时，请检查网络后重试');
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

// 试衣是**同步**接口：Edge Function 要等供应商把图生成完才返回（Aidge 实测 40–70 秒，
// 供应商侧超时上限 90 秒），所以这里的客户端超时必须比它长，否则会出现
//「界面报失败、后台其实成功了」的错位（实测过一次：任务 status=done，用户却看到失败）。
const TRYON_CREATE_TIMEOUT_MS = 180_000;

export async function createTryonTask(
  userPhotoUrl: string,
  garmentId: string,
  // useBack：用这件单品的背面平铺图去试（021 迁移 + 管理端上传了背面图才有意义）。
  // 试衣模型只吃一张衣服图，正面推出来的背面褶裥全是编的，所以背面要单独跑一次。
  options: { useBack?: boolean } = {},
) {
  // 桶私有化之后 Edge Function 直接下载公共地址会 400，必须换成带签名的临时地址
  const fetchableUrl = await signStorageUrl(userPhotoUrl).catch(() => userPhotoUrl);
  const headers = await buildEdgeHeaders();
  headers['x-device-id'] = await getDeviceId();
  const { data, error } = await supabase.functions.invoke<{ task_id: string; status: string; error?: string }>(
    'tryon',
    {
      body: { user_photo_url: fetchableUrl, garment_id: garmentId, use_back: Boolean(options.useBack) },
      headers,
      timeout: TRYON_CREATE_TIMEOUT_MS,
    },
  );

  if (error) {
    const message = await getFunctionErrorMessage(error as FunctionInvokeError);
    // 万一网关先断开，任务通常还在服务端跑，给出「去我的看结果」而不是让用户白等重试
    if (/timeout|timed out|abort/i.test(message)) {
      throw new NetworkError('生成还在后台进行，请稍后到「我的」查看结果');
    }
    throw new Error(message);
  }
  if (!data?.task_id) throw new Error(data?.error || '无法创建试衣任务，请检查 Edge Function 是否已部署');
  return data.task_id;
}

export async function fetchTryonTask(taskId: string): Promise<TryonTask> {
  const url = process.env.EXPO_PUBLIC_SUPABASE_URL;
  if (!url) throw new Error('缺少 Supabase 配置');
  const response = await fetchEdge(`${url}/functions/v1/tryon?id=${encodeURIComponent(taskId)}`, {
    headers: await buildEdgeHeaders(),
  });
  // 网关异常时可能返回 HTML 或空体，直接 json() 会抛出「Unexpected token <」这种不可读错误
  const text = await response.text();
  let data: (TryonTask & { error?: string }) | null = null;
  try {
    data = text ? (JSON.parse(text) as TryonTask & { error?: string }) : null;
  } catch {
    data = null;
  }
  if (!response.ok) throw new Error(data?.error || `试衣状态查询失败（${response.status}）`);
  if (!data) throw new Error('试衣状态查询返回了无法解析的内容，请稍后重试');
  return withDisplayUrls(data);
}

export async function fetchPoses(gender?: string): Promise<Pose[]> {
  const data = await withRetry(async () => {
    let query = supabase
      .from('poses')
      .select('id,name,pose_desc,image_url,gender')
      .order('created_at', { ascending: false });
    if (gender && gender !== 'unisex') query = query.in('gender', [gender, 'unisex']);
    const { data, error } = await query;
    if (error) throw new Error(error.message);
    return data ?? [];
  });
  return data as Pose[];
}

export type VideoBackground = 'keep' | 'studio-white' | 'studio-gray' | 'street' | 'cafe' | 'seaside';

export async function createVideoTask(
  taskId: string,
  poseId: string | null,
  options: { background?: VideoBackground; duration?: number; resolution?: '480P' | '720P' } = {},
) {
  const headers = await buildEdgeHeaders();
  headers['x-device-id'] = await getDeviceId();
  const { data, error } = await supabase.functions.invoke<{ task_id: string; status: string; error?: string }>(
    'video',
    {
      body: {
        task_id: taskId,
        ...(poseId ? { pose_id: poseId } : {}),
        duration: options.duration ?? 5,
        ...(options.background && options.background !== 'keep' ? { background: options.background } : {}),
        ...(options.resolution ? { resolution: options.resolution } : {}),
      },
      headers,
      timeout: 20_000,
    },
  );
  if (error) throw new Error(await getFunctionErrorMessage(error as FunctionInvokeError));
  if (!data?.task_id) throw new Error(data?.error || '无法创建视频任务，请检查 Edge Function 的视频服务配置');
}

export async function fetchVideoTask(taskId: string): Promise<TryonTask> {
  const url = process.env.EXPO_PUBLIC_SUPABASE_URL;
  if (!url) throw new Error('缺少 Supabase 配置');
  const response = await fetchEdge(`${url}/functions/v1/video?id=${encodeURIComponent(taskId)}`, {
    headers: await buildEdgeHeaders(),
  });
  const text = await response.text();
  let data: (TryonTask & { error?: string }) | null = null;
  try {
    data = text ? (JSON.parse(text) as TryonTask & { error?: string }) : null;
  } catch {
    data = null;
  }
  if (!response.ok) throw new Error(data?.error || `视频状态查询失败（${response.status}）`);
  if (!data) throw new Error('视频状态查询返回了无法解析的内容，请稍后重试');
  return withDisplayUrls(data);
}

export async function fetchTryonHistory(): Promise<(TryonTask & { garment: Pick<Garment, 'id' | 'name' | 'category'> | null })[]> {
  const data = await withRetry(async () => {
    const { data, error } = await supabase
      .from('tryon_tasks')
      .select('id,user_photo_url,output_type,status,first_frame_url,result_url,error_msg,created_at,garments(id,name,category)')
      .order('created_at', { ascending: false });
    if (error) throw new Error(error.message);
    return data ?? [];
  });

  const rows = data.map((row) => ({
    ...row,
    garment: Array.isArray(row.garments) ? row.garments[0] ?? null : row.garments,
  })) as unknown as (TryonTask & { garment: Pick<Garment, 'id' | 'name' | 'category'> | null })[];

  // 一次性把这一页所有私有图片签完，避免「我的」页首屏打十几张签名请求
  const signed = await resolveDisplayUrls(
    rows.flatMap((row) => [row.user_photo_url, row.first_frame_url, row.result_url]),
  );
  return rows.map((row) => withSignedMedia(row, signed));
}

function storagePathFromPublicUrl(url: string, bucket: string) {
  // 兼容三种历史形态：public 直链、sign 签名链（库里可能存了带 token 的旧值）、新规范地址
  const ref = parseStorageUrl(url);
  return ref && ref.bucket === bucket ? ref.path : null;
}

/**
 * 删除一条试穿记录。
 *
 * 顺序很重要：数据库行是唯一不可再生的东西，Storage 媒体反而是可以重试清理的。
 * 所以先删行并确认真的删掉了（RLS 拒绝时 PostgREST 仍返回 204 且 0 行），
 * 再清理媒体；媒体清理失败只降级为 warning，避免出现「记录还在但照片已经没了」。
 */
export async function deleteTryonTask(task: TryonTask): Promise<{ warning: string | null }> {
  // Storage 删除策略只允许删 `<uid>/...` 前缀的对象；无会话或迁移前的旧路径不尝试删除，
  // 避免触发 403，旧对象需要时用 service_role 脚本清理。
  const { data: authData } = await supabase.auth.getUser();
  const ownerPrefix = authData.user?.id ? `${authData.user.id}/` : null;
  const canDeleteObject = (path: string) => Boolean(ownerPrefix && path.startsWith(ownerPrefix));

  // 桶名不能写死：历史记录的照片在 user-photos，新上传在私有的 user-media
  const userPhotoRef = parseStorageUrl(task.user_photo_url ?? '');
  let userPhotoPath = userPhotoRef
    && (userPhotoRef.bucket === 'user-media' || userPhotoRef.bucket === 'user-photos')
    ? userPhotoRef.path
    : null;
  if (userPhotoPath && task.user_photo_url) {
    // 不能直接按字符串比：私有桶之后同一个对象每次签名得到的 token 不同，
    // 同一张照片在两行里可能长得不一样。所以先取回候选行，再比「去掉 token 的规范地址」。
    const canonical = canonicalStorageUrl(task.user_photo_url);
    const { data: otherTasks, error: sharedError } = await supabase
      .from('tryon_tasks')
      .select('id,user_photo_url')
      .neq('id', task.id)
      .not('user_photo_url', 'is', null);
    if (sharedError) throw new Error(sharedError.message);
    const stillUsed = (otherTasks ?? []).some(
      (row) => canonicalStorageUrl(String((row as { user_photo_url: string }).user_photo_url)) === canonical,
    );
    if (stillUsed) userPhotoPath = null;
  }
  if (userPhotoPath && !canDeleteObject(userPhotoPath)) userPhotoPath = null;

  // 视频任务的 result_url 是 mp4，first_frame_url 仍是 jpg，两者都要清理，否则首帧成孤儿
  const resultPaths = Array.from(new Set([
    storagePathFromPublicUrl(task.result_url ?? '', 'tryon-results'),
    storagePathFromPublicUrl(task.first_frame_url ?? '', 'tryon-results'),
  ].filter((path): path is string => path !== null && canDeleteObject(path))));

  // 1) 先删数据库行（不可恢复的那一份），并确认真的删掉了
  const { data: deleted, error } = await supabase.from('tryon_tasks').delete().eq('id', task.id).select('id');
  if (error) throw new Error(error.message);
  if (!deleted?.length) throw new Error('记录未删除：当前账号没有删除权限');

  // 2) 行已经删掉，媒体清理失败不影响记录本身，只提示用户
  const storageResults = await Promise.all([
    userPhotoPath && userPhotoRef
      ? supabase.storage.from(userPhotoRef.bucket).remove([userPhotoPath])
      : Promise.resolve({ error: null }),
    ...resultPaths.map((path) => supabase.storage.from('tryon-results').remove([path])),
  ]);
  const storageError = storageResults.find((result) => result.error)?.error;
  return { warning: storageError ? `记录已删除，但文件清理失败：${storageError.message}` : null };
}
