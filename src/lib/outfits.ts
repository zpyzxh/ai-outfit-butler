import type { Garment } from './supabase';

/**
 * 搭配推荐引擎（纯函数，不依赖网络）
 *
 * 输入：衣橱单品（garments 表）+ 用户风格档案 + 今日天气
 * 输出：按契合度排序的成套搭配
 *
 * 设计取舍：
 * - 不做「生成新图」，只用真实单品做拼贴，所以零额外成本、立刻可用；
 * - 打分项只保留能量化的维度（完整度 / 色彩和谐 / 冷暖匹配 / 档案偏好），
 *   避免出现「看起来像随便排的」推荐；
 * - 所有结果带一句可读理由，用户能判断为什么推荐它。
 */

export type OutfitRole = 'top' | 'bottom' | 'dress' | 'outer';

export type OutfitPiece = { garment: Garment; role: OutfitRole };

export type Outfit = {
  id: string;
  title: string;
  pieces: OutfitPiece[];
  reason: string;
  tags: string[];
  score: number;
};

export type OutfitContext = {
  tempC?: number | null;
  /** 风格档案里的气质/场合标签，用于加权 */
  vibes?: string[];
  occasions?: string[];
  /** 换一批：同一组数据用不同 seed 会得到不同排序 */
  seed?: number;
};

const LIGHT_NEUTRALS = ['白', '米', '奶', '驼', '杏', '燕麦', '象牙', '沙', '浅灰'];
const DARK_NEUTRALS = ['黑', '藏', '深', '炭', '墨', '咖', '灰', '棕'];
const WARM_WORDS = ['羊毛', '针织', '西装', '大衣', '呢', '绒', '毛', '卫衣', '夹克'];
const COOL_WORDS = ['亚麻', '薄', '短袖', 't恤', 'T恤', '雪纺', '真丝', '吊带', '背心', '衬衫'];

const OCCASION_HINTS: Record<string, string[]> = {
  通勤: ['西装', '衬衫', '直筒', '阔腿', '针织', '外套'],
  约会: ['连衣裙', '真丝', '雪纺', '褶', 'A字'],
  出行: ['牛仔', 't恤', 'T恤', '运动', '卫衣', '阔腿'],
  聚会: ['连衣裙', '外套', '西装', '皮', '亮'],
  居家: ['棉', '针织', '宽松', '阔腿'],
};

const VIBE_HINTS: Record<string, string[]> = {
  极简: ['白', '黑', '灰', '直筒', '衬衫', '西装'],
  复古: ['驼', '棕', '牛仔', '格', '针织'],
  通勤: ['西装', '衬衫', '直筒', '阔腿'],
  甜酷: ['黑', '皮', '短', '褶'],
  松弛: ['亚麻', '宽松', '针织', '阔腿', '棉'],
  先锋: ['结构', '不对称', '亮', '皮'],
};

export function roleOf(garment: Garment): OutfitRole {
  const category = garment.category ?? '';
  if (category.includes('连衣')) return 'dress';
  if (category.includes('外套')) return 'outer';
  if (category.includes('上装')) return 'top';
  if (category.includes('下装')) return 'bottom';

  const name = `${garment.name ?? ''}`;
  if (/连衣裙|连体|长裙/.test(name)) return 'dress';
  if (/外套|西装|大衣|夹克|风衣/.test(name)) return 'outer';
  if (/裤|半裙|短裤|长裤/.test(name)) return 'bottom';
  return 'top';
}

export function colorFamily(garment: Garment): 'light' | 'dark' | 'accent' {
  const text = `${garment.color ?? ''}${garment.name ?? ''}`;
  if (LIGHT_NEUTRALS.some((word) => text.includes(word))) return 'light';
  if (DARK_NEUTRALS.some((word) => text.includes(word))) return 'dark';
  return 'accent';
}

function isWarm(garment: Garment) {
  const text = `${garment.name ?? ''}${garment.color ?? ''}`;
  return WARM_WORDS.some((word) => text.includes(word));
}

function isCool(garment: Garment) {
  const text = `${garment.name ?? ''}${garment.color ?? ''}`;
  return COOL_WORDS.some((word) => text.includes(word));
}

function temperatureBand(tempC: number | null | undefined) {
  if (typeof tempC !== 'number' || Number.isNaN(tempC)) return 'unknown' as const;
  if (tempC >= 26) return 'hot' as const;
  if (tempC >= 20) return 'warm' as const;
  if (tempC >= 14) return 'mild' as const;
  return 'cold' as const;
}

function seededShuffle<T>(list: T[], seed: number): T[] {
  const result = [...list];
  let state = Math.floor(Math.abs(seed)) % 2147483647 || 1;
  for (let i = result.length - 1; i > 0; i -= 1) {
    state = (state * 16807) % 2147483647;
    const j = state % (i + 1);
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

function hashString(value: string) {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash * 31 + value.charCodeAt(i)) % 2147483647;
  }
  return hash;
}

function reasonFor(pieces: OutfitPiece[], band: ReturnType<typeof temperatureBand>) {
  const by = (role: OutfitRole) => pieces.find((piece) => piece.role === role)?.garment;
  const dress = by('dress');
  const top = by('top');
  const bottom = by('bottom');
  const outer = by('outer');

  const families = pieces.map((piece) => colorFamily(piece.garment));
  const colorNote = families.every((family) => family !== 'accent')
    ? '中性色打底，稳妥耐看'
    : families.filter((family) => family === 'accent').length === 1
      ? '留一个彩色主角，其余压暗不抢镜'
      : '两个彩色对撞，适合想被看见的日子';

  const lead = dress
    ? `一条「${dress.name}」成型`
    : outer
      ? `「${top?.name ?? ''}」配「${bottom?.name ?? ''}」，外搭「${outer.name}」压住整身`
      : `「${top?.name ?? ''}」配「${bottom?.name ?? ''}」`;

  const bandNote =
    band === 'hot'
      ? '今天偏热，这套透气不闷'
      : band === 'cold'
        ? '今天偏冷，层次感保暖两不误'
        : band === 'unknown'
          ? ''
          : '温差不大，这套刚刚好';

  return [lead, colorNote, bandNote].filter(Boolean).join('，');
}

function titleFor(pieces: OutfitPiece[], score: number, seed: number) {
  const count = pieces.length;
  const hasOuter = pieces.some((piece) => piece.role === 'outer');
  const pool = count === 1
    ? ['一件成型', '极简一套', '轻松出门']
    : hasOuter
      ? ['三件套通勤', '层次感叠穿', '外套季首选']
      : ['两件套日常', '基础款进阶', '周末松弛感'];
  return pool[(seed + Math.round(score)) % pool.length];
}

function tagsFor(pieces: OutfitPiece[], vibes: string[], occasions: string[]) {
  const text = pieces.map((piece) => `${piece.garment.name}${piece.garment.color ?? ''}`).join(' ');
  const tags: string[] = [];
  for (const vibe of vibes) {
    const hints = VIBE_HINTS[vibe] ?? [];
    if (hints.some((hint) => text.includes(hint))) tags.push(vibe);
  }
  for (const occasion of occasions) {
    const hints = OCCASION_HINTS[occasion] ?? [];
    if (hints.some((hint) => text.includes(hint))) tags.push(occasion);
  }
  const unique = Array.from(new Set(tags)).slice(0, 3);
  if (unique.length === 0) unique.push(colorFamily(pieces[0].garment) === 'accent' ? '个性' : '百搭');
  return unique;
}

/** 把衣橱拆成可用角色，空角色会被后续组合逻辑跳过 */
function splitByRole(garments: Garment[]) {
  const buckets: Record<OutfitRole, Garment[]> = { top: [], bottom: [], dress: [], outer: [] };
  for (const garment of garments) {
    if (!garment.flat_image_url && !garment.model_image_url) continue;
    buckets[roleOf(garment)].push(garment);
  }
  return buckets;
}

function candidatePieces(buckets: ReturnType<typeof splitByRole>): OutfitPiece[][] {
  const candidates: OutfitPiece[][] = [];
  const outer = buckets.outer[0];

  for (const dress of buckets.dress) {
    candidates.push([{ garment: dress, role: 'dress' }]);
    if (outer) candidates.push([{ garment: dress, role: 'dress' }, { garment: outer, role: 'outer' }]);
  }

  for (const top of buckets.top) {
    for (const bottom of buckets.bottom) {
      candidates.push([{ garment: top, role: 'top' }, { garment: bottom, role: 'bottom' }]);
      if (outer) {
        candidates.push([
          { garment: top, role: 'top' },
          { garment: bottom, role: 'bottom' },
          { garment: outer, role: 'outer' },
        ]);
      }
    }
  }

  // 单品兜底：衣橱还很少时也要有内容可看
  if (candidates.length === 0) {
    for (const garment of [...buckets.top, ...buckets.bottom, ...buckets.dress, ...buckets.outer]) {
      candidates.push([{ garment, role: roleOf(garment) }]);
    }
  }

  return candidates;
}

function scoreOutfit(pieces: OutfitPiece[], context: OutfitContext) {
  let score = 10;
  const band = temperatureBand(context.tempC);

  if (pieces.length >= 2) score += 2;
  if (pieces.length >= 3) score += 1;

  const families = pieces.map((piece) => colorFamily(piece.garment));
  const accents = families.filter((family) => family === 'accent').length;
  if (accents === 0) score += 1.5;
  if (accents >= 2) score -= 2;
  if (accents === 1) score += 0.5;

  const warm = pieces.some((piece) => isWarm(piece.garment));
  const cool = pieces.some((piece) => isCool(piece.garment));
  const hasOuter = pieces.some((piece) => piece.role === 'outer');

  if (band === 'hot') {
    if (cool) score += 2;
    if (warm) score -= 2.5;
    if (hasOuter) score -= 1.5;
  } else if (band === 'warm') {
    if (cool) score += 1;
    if (warm) score -= 0.5;
  } else if (band === 'mild') {
    if (hasOuter) score += 1;
  } else if (band === 'cold') {
    if (hasOuter) score += 2.5;
    if (warm) score += 1.5;
    if (!hasOuter && !warm) score -= 1;
  }

  const text = pieces.map((piece) => `${piece.garment.name}${piece.garment.color ?? ''}`).join(' ');
  for (const vibe of context.vibes ?? []) {
    if ((VIBE_HINTS[vibe] ?? []).some((hint) => text.includes(hint))) score += 1.2;
  }
  for (const occasion of context.occasions ?? []) {
    if ((OCCASION_HINTS[occasion] ?? []).some((hint) => text.includes(hint))) score += 1;
  }

  return score;
}

/** 推荐主入口：返回已排序、已去重的搭配列表 */
export function buildOutfits(garments: Garment[], context: OutfitContext = {}): Outfit[] {
  const buckets = splitByRole(garments);
  const seed = context.seed ?? 1;
  const candidates = seededShuffle(candidatePieces(buckets), seed + 17);

  const outfits = candidates.map((pieces) => {
    const score = scoreOutfit(pieces, context);
    const piecesKey = pieces.map((piece) => piece.garment.id).sort().join('|');
    const band = temperatureBand(context.tempC);
    return {
      id: `outfit-${hashString(piecesKey)}`,
      title: titleFor(pieces, score, seed),
      pieces,
      reason: reasonFor(pieces, band),
      tags: tagsFor(pieces, context.vibes ?? [], context.occasions ?? []),
      score,
    } satisfies Outfit;
  });

  const seen = new Set<string>();
  return outfits
    .sort((a, b) => b.score - a.score)
    .filter((outfit) => {
      if (seen.has(outfit.id)) return false;
      seen.add(outfit.id);
      return true;
    });
}

/** 取前 N 套，且尽量不让同一件主单品重复出现 */
export function pickTopOutfits(outfits: Outfit[], count = 3) {
  const picked: Outfit[] = [];
  const used = new Set<string>();
  for (const outfit of outfits) {
    const signature = outfit.pieces.map((piece) => piece.garment.id).join('|');
    if (used.has(signature)) continue;
    // 主单品（第一条）已被别的推荐占用时，优先让位给新面孔
    const primary = outfit.pieces[0]?.garment.id;
    if (picked.length >= 1 && primary && picked.some((item) => item.pieces[0]?.garment.id === primary)) {
      const canSkip = outfits.some(
        (candidate) =>
          !used.has(candidate.pieces.map((piece) => piece.garment.id).join('|')) &&
          candidate.pieces[0]?.garment.id !== primary,
      );
      if (canSkip) continue;
    }
    picked.push(outfit);
    used.add(signature);
    if (picked.length >= count) break;
  }
  return picked;
}

/** 与搭配相关的温度文案，供页面头部使用 */
export function weatherHint(tempC: number | null | undefined) {
  const band = temperatureBand(tempC);
  switch (band) {
    case 'hot':
      return '偏热 · 轻薄透气优先';
    case 'warm':
      return '舒适 · 单件加薄外搭';
    case 'mild':
      return '微凉 · 适合叠穿';
    case 'cold':
      return '偏冷 · 外套和针织上场';
    default:
      return '按体感选择层次';
  }
}
