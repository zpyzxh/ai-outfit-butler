import { useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { AppIcon } from '@/components/icons';
import { ResultVideo } from '@/components/ResultVideo';
import {
  DEMO_BADGE,
  DEMO_MODE,
  DEMO_SAMPLE_PHOTO,
  DEMO_TRYON_STEP_MS,
  DEMO_VIDEO,
  DEMO_VIDEO_MS,
  demoResultFor,
} from '@/lib/demo';
import { toUserMessage } from '@/lib/errors';
import { saveRemoteFile, suggestFilename } from '@/lib/download';
import { CAN_CAPTURE_FRAME, captureLastFrame, saveBackFrame } from '@/lib/garmentBack';
import { publishInspirationFromUrl } from '@/lib/inspirationUpload';
import { clearInflight, loadInflight, saveInflight } from '@/lib/inflight';
import {
  createTryonTask,
  createVideoTask,
  fetchPoses,
  fetchTryonTask,
  fetchVideoTask,
  fetchGarments,
  resolveDisplayUrl,
  type Garment,
  type Pose,
} from '@/lib/supabase';
import { pickAndUploadUserPhoto } from '@/lib/userPhoto';
import { buildOutfits, pickTopOutfits, roleOf, type OutfitRole } from '@/lib/outfits';
import { useTheme, useThemedStyles, type Theme } from '@/theme';

const POLL_INTERVAL_MS = 5000;
const MAX_WAIT_MS = 15 * 60_000;
// 实测通义万相排队时单条 5 秒视频要 20 分钟以上，客户端不能提前放弃，
// 否则任务还在跑、页面已经报错，用户以为失败会重复提交（重复计费）。
const MAX_VIDEO_WAIT_MS = 30 * 60_000;
const MAX_POLL_ERRORS = 3;
const MAX_STEPS = 3;

const ROLE_LABEL: Record<OutfitRole, string> = {
  top: '上装',
  bottom: '下装',
  dress: '连衣裙',
  outer: '外套',
};

const ROLE_ORDER: Record<OutfitRole, number> = { top: 0, outer: 1, bottom: 2, dress: 0 };

// 视频背景预设：与 supabase/functions/video 的 BACKGROUND_PRESETS 一一对应。
// 换背景等于让模型重绘全画面，最容易把人和衣服带崩，所以默认「原背景」。
type VideoBackground = 'keep' | 'studio-white' | 'studio-gray' | 'street' | 'cafe' | 'seaside';

const POSE_DIAGRAMS = [
  require('../../../assets/poses/01-natural.png'),
  require('../../../assets/poses/02-step.png'),
  require('../../../assets/poses/03-turn.png'),
  require('../../../assets/poses/04-hand-in-pocket.png'),
  require('../../../assets/poses/05-side.png'),
  require('../../../assets/poses/06-hair.png'),
];

const BG_OPTIONS: Array<{ id: VideoBackground; label: string }> = [
  { id: 'keep', label: '原背景' },
  { id: 'studio-white', label: '纯白棚' },
  { id: 'studio-gray', label: '灰棚' },
  { id: 'street', label: '街拍' },
  { id: 'cafe', label: '咖啡店' },
  { id: 'seaside', label: '海边' },
];

const CATEGORIES = ['全部', '连衣裙', '上装', '下装', '外套'];

type StepState = {
  index: number;
  total: number;
  garment: Garment;
  label: string;
  previewUrl?: string;
};

export default function TryonScreen() {
  const { theme } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { colors, nav } = theme;
  const params = useLocalSearchParams<{
    garmentId?: string;
    look?: string;
    lookTitle?: string;
    autoVideo?: string;
  }>();

  const [garments, setGarments] = useState<Garment[]>([]);
  const [photoUrl, setPhotoUrl] = useState<string | null>(null);
  // 桶私有化后，规范地址不能直接喂给 <Image>，要单独留一份签名地址
  const [photoView, setPhotoView] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [searchText, setSearchText] = useState('');
  const [activeCategory, setActiveCategory] = useState('全部');

  const [loadingGarments, setLoadingGarments] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [step, setStep] = useState<StepState | null>(null);
  const [stageLabel, setStageLabel] = useState('');
  const [waitedSeconds, setWaitedSeconds] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const [resultUrl, setResultUrl] = useState<string | null>(null);
  // 背面视角的补充说明（用背面平铺图重跑出来的结果，要标清楚来源）
  const [resultNote, setResultNote] = useState<string | null>(null);
  const [showBackRef, setShowBackRef] = useState(false);
  const [savingBack, setSavingBack] = useState(false);
  // 下载是浏览器异步动作，给一句反馈，避免用户以为按钮没反应
  const [saveHint, setSaveHint] = useState<string | null>(null);
  const [backSavedHint, setBackSavedHint] = useState<string | null>(null);
  const [resultTaskId, setResultTaskId] = useState<string | null>(null);
  const [completedSteps, setCompletedSteps] = useState<{ label: string; url: string }[]>([]);

  const [poses, setPoses] = useState<Pose[]>([]);
  const [selectedPoseId, setSelectedPoseId] = useState<string | null>(null);
  const [poseSheetVisible, setPoseSheetVisible] = useState(false);
  const [videoBackground, setVideoBackground] = useState<VideoBackground>('keep');
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [generatingVideo, setGeneratingVideo] = useState(false);
  const [videoWaited, setVideoWaited] = useState(0);

  const [publishSheetVisible, setPublishSheetVisible] = useState(false);
  const [publishCaption, setPublishCaption] = useState('');
  const [publishing, setPublishing] = useState(false);
  const [published, setPublished] = useState(false);

  const aliveRef = useRef(true);
  // 用户主动取消：只停前端轮询与后续叠加，服务端那一张照跑（钱已经花了），
  // 所以取消不删任务、也不清 inflight —— 回来后还能在「我的」看到它。
  const cancelRef = useRef(false);
  const chainLockRef = useRef(false);
  const videoLockRef = useRef(false);

  const loadGarments = useCallback(async () => {
    setLoadingGarments(true);
    setLoadError(null);
    try {
      const list = await fetchGarments();
      if (!aliveRef.current) return;
      setGarments(list);
    } catch (err) {
      if (!aliveRef.current) return;
      setLoadError(toUserMessage(err, '衣服列表读取失败，请下拉重试'));
    } finally {
      if (aliveRef.current) setLoadingGarments(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      aliveRef.current = true;
      void loadGarments();
      return () => {
        aliveRef.current = false;
      };
    }, [loadGarments]),
  );

  // 三个入口：首页「试穿同款」(garmentId)、搭配页「试穿这套」(look=id,id,id)、底栏直接进入。
  // 关键：换入口时必须把上一件的结果清掉。这个页面在 Tab 里常驻，不清的话会出现
  // 「选了牛仔裤，结果区还挂着连衣裙的图」——用户再点出视频，用的就是上一件的首帧。
  const resetResult = useCallback(() => {
    setResultUrl(null);
    setVideoUrl(null);
    setResultTaskId(null);
    setCompletedSteps([]);
    setResultNote(null);
    setShowBackRef(false);
    setPublished(false);
    setBackSavedHint(null);
    setError(null);
  }, []);

  const entryKeyRef = useRef<string>('');
  useEffect(() => {
    const fromLook = (params.look || '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean)
      .slice(0, MAX_STEPS);
    const entryKey = `${params.look || ''}|${params.garmentId || ''}`;
    const isNewEntry = entryKey !== entryKeyRef.current;
    entryKeyRef.current = entryKey;

    if (fromLook.length) {
      setSelectedIds(fromLook);
    } else if (params.garmentId) {
      setSelectedIds([params.garmentId]);
    }
    // 首次进入（热启动恢复的任务）不要清，否则会把接回来的结果抹掉
    if (isNewEntry && entryKey !== '|') resetResult();
  }, [params.garmentId, params.look, resetResult]);

  // 离开页面再回来时，自动接回没跑完的任务。
  // 视频尤其需要：万相排队常见十几二十分钟，之前这种情况下用户回到页面只看到空白，
  // 要么以为失败重新点一次（重复扣费），要么覆盖掉已经生成好的视频。
  // 从搭配页的「出视频」进来时，整套串行试穿完要自动接着生成视频
  const autoVideoRef = useRef(false);
  useEffect(() => {
    autoVideoRef.current = params.autoVideo === '1';
  }, [params.autoVideo]);

  const resumeLockRef = useRef(false);
  useEffect(() => {
    if (resumeLockRef.current) return;
    resumeLockRef.current = true;
    let cancelled = false;

    const run = async () => {
      const pending = await loadInflight();
      if (!pending || cancelled || !aliveRef.current) return;

      if (pending.kind === 'tryon') {
        chainLockRef.current = true;
        setGenerating(true);
        setStageLabel(`正在接回上次的${pending.label}`);
        try {
          const url = await pollTryon(pending.taskId);
          if (!cancelled && aliveRef.current && url) {
            setResultUrl(url);
            setResultTaskId(pending.taskId);
            setCompletedSteps([{ label: pending.label, url }]);
            // 任务行里记着当时那件单品，接回来时顺手选上，
            // 这样「看背面实物图」「存为背面素材」才有单品可用
            const resumed = await fetchTryonTask(pending.taskId).catch(() => null);
            const garmentId = resumed?.garment_id ?? null;
            if (garmentId) setSelectedIds((prev) => (prev.length ? prev : [garmentId]));
          }
          await clearInflight();
        } catch (err) {
          // 任务已经结束（可能成功了但记录丢了），清掉标记，别让用户一直等
          await clearInflight();
          if (aliveRef.current) setError(toUserMessage(err, '上次的生成任务已结束，请重新试一次'));
        } finally {
          chainLockRef.current = false;
          if (aliveRef.current) {
            setGenerating(false);
            setStageLabel('');
          }
        }
        return;
      }

      videoLockRef.current = true;
      setGeneratingVideo(true);
      try {
        // 视频任务挂在已有的试穿结果上，先把首帧取回来，结果区才有图可显示
        const current = await fetchVideoTask(pending.taskId).catch(() => null);
        if (!cancelled && aliveRef.current) {
          if (current?.first_frame_url) setResultUrl(current.first_frame_url);
          setResultTaskId(pending.taskId);
          const garmentId = current?.garment_id ?? null;
          if (garmentId) setSelectedIds((prev) => (prev.length ? prev : [garmentId]));
        }
        const url = await pollVideo(pending.taskId);
        if (!cancelled && aliveRef.current && url) setVideoUrl(url);
        await clearInflight();
      } catch {
        await clearInflight();
      } finally {
        videoLockRef.current = false;
        if (aliveRef.current) setGeneratingVideo(false);
      }
    };

    void run();
    return () => {
      cancelled = true;
    };
    // 只在挂载时跑一次：之后的任务由 startTryon / startVideo 自己接管
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 姿势只在拿到结果图后加载，避免每次进页面都多打一次请求
  useEffect(() => {
    if (!resultUrl) return;
    let cancelled = false;
    void fetchPoses()
      .then((list) => {
        if (!cancelled && aliveRef.current) setPoses(list);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [resultUrl]);

  useEffect(() => {
    if (!generating) return;
    const timer = setInterval(() => setWaitedSeconds((value) => value + 1), 1000);
    return () => clearInterval(timer);
  }, [generating]);

  useEffect(() => {
    if (!generatingVideo) return;
    const timer = setInterval(() => setVideoWaited((value) => value + 1), 1000);
    return () => clearInterval(timer);
  }, [generatingVideo]);

  const filtered = useMemo(() => {
    const keyword = searchText.trim().toLowerCase();
    return garments.filter((garment) => {
      if (activeCategory !== '全部' && garment.category !== activeCategory) return false;
      if (!keyword) return true;
      return [garment.name, garment.category, garment.color].filter(Boolean).join(' ').toLowerCase().includes(keyword);
    });
  }, [garments, searchText, activeCategory]);

  const selectedGarments = useMemo(
    () =>
      selectedIds
        .map((id) => garments.find((garment) => garment.id === id))
        .filter((garment): garment is Garment => Boolean(garment)),
    [selectedIds, garments],
  );

  /** 串行顺序：上装 → 外套 → 下装（连衣裙独占一步） */
  const chain = useMemo(() => {
    return [...selectedGarments].sort((a, b) => ROLE_ORDER[roleOf(a)] - ROLE_ORDER[roleOf(b)]);
  }, [selectedGarments]);

  const toggleGarment = (garment: Garment) => {
    setError(null);
    setSelectedIds((current) => {
      if (current.includes(garment.id)) return current.filter((id) => id !== garment.id);
      if (current.length >= MAX_STEPS) {
        setError(`一次最多试 ${MAX_STEPS} 件，先取消一件再选`);
        return current;
      }
      return [...current, garment.id];
    });
    setResultUrl(null);
    setCompletedSteps([]);
    setVideoUrl(null);
  };

  const choosePhoto = async () => {
    if (uploading || generating) return;
    setError(null);

    // 演示模式：不选文件、不上传，直接用内置示例全身照
    if (DEMO_MODE) {
      setPhotoUrl(DEMO_SAMPLE_PHOTO);
      setPhotoView(DEMO_SAMPLE_PHOTO);
      setResultUrl(null);
      setResultTaskId(null);
      setCompletedSteps([]);
      setVideoUrl(null);
      return;
    }

    setUploading(true);
    try {
      const url = await pickAndUploadUserPhoto();
      if (!url || !aliveRef.current) return;
      setPhotoUrl(url);
      setPhotoView(await resolveDisplayUrl(url).catch(() => url));
      setResultUrl(null);
      setResultTaskId(null);
      setCompletedSteps([]);
      setVideoUrl(null);
    } catch (err) {
      if (aliveRef.current) setError(toUserMessage(err, '照片上传失败，请重试'));
    } finally {
      if (aliveRef.current) setUploading(false);
    }
  };

  const pollTryon = async (taskId: string) => {
    const startedAt = Date.now();
    let pollErrors = 0;

    while (Date.now() - startedAt < MAX_WAIT_MS) {
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      if (!aliveRef.current) return null;
      if (cancelRef.current) return null;

      try {
        const task = await fetchTryonTask(taskId);
        pollErrors = 0;
        const url = task.first_frame_url || task.result_url;
        if (task.status === 'done' && url) return url;
        if (task.status === 'failed' || task.status === 'timeout') {
          throw new Error(task.error_msg || '试衣生成失败，请重试');
        }
      } catch (err) {
        if (err instanceof Error && /失败|超时|error_msg/.test(err.message)) throw err;
        pollErrors += 1;
        if (pollErrors >= MAX_POLL_ERRORS) throw new Error('网络不稳定，生成状态查询中断，请稍后到「我的」查看结果');
      }
    }

    throw new Error('等待时间较长，结果可能仍在生成，请稍后到「我的」查看');
  };

  // 一键带入「今日搭配」：复用搭配页的同一套推荐引擎（iOS/Android/Web 同源逻辑），
  // 只取评分最高的一套，避免用户自己一件件点。
  const applyTodayLook = () => {
    const best = pickTopOutfits(buildOutfits(garments, {}), 1)[0];
    if (!best) {
      setError('衣橱里还没有能凑成一套的单品，先去素材管理上传几张平铺图。');
      return;
    }
    setResultUrl(null);
    setResultTaskId(null);
    setVideoUrl(null);
    setCompletedSteps([]);
    setError(null);
    setSelectedIds(best.pieces.slice(0, MAX_STEPS).map((piece) => piece.garment.id));
  };

  const startTryon = async () => {
    if (!photoUrl) {
      setError('先上传一张全身照');
      return;
    }
    if (!chain.length) {
      setError('至少选一件衣服');
      return;
    }
    if (chainLockRef.current) return;

    // 演示模式：按件数走一遍进度，最后给预生成的真实结果，不调用任何 AI
    if (DEMO_MODE) {
      chainLockRef.current = true;
      cancelRef.current = false;
      setResultNote(null);
      setError(null);
      setGenerating(true);
      setResultUrl(null);
      setResultTaskId(null);
      setCompletedSteps([]);
      setVideoUrl(null);
      setWaitedSeconds(0);

      const done: { label: string; url: string }[] = [];
      try {
        for (let index = 0; index < chain.length; index += 1) {
          if (cancelRef.current) break;
          const garment = chain[index];
          setStep({
            index: index + 1,
            total: chain.length,
            garment,
            label: `${ROLE_LABEL[roleOf(garment)]} · ${garment.name}`,
            previewUrl: index === 0 ? DEMO_SAMPLE_PHOTO : done[index - 1].url,
          });
          setStageLabel(index === 0 ? '正在生成试穿效果' : `正在叠加第 ${index + 1} 件`);
          await new Promise((resolve) => setTimeout(resolve, DEMO_TRYON_STEP_MS));
          if (!aliveRef.current) return;
          const url = demoResultFor(index);
          done.push({ label: garment.name, url });
          setCompletedSteps([...done]);
          setResultUrl(url);
        }
        setStageLabel('');
        setResultNote(`${DEMO_BADGE}：这张图来自本项目真实跑过的结果，演示模式下不会真的调用 AI，也不消耗额度。`);
      } finally {
        if (aliveRef.current) {
          setGenerating(false);
          setStep(null);
          setStageLabel('');
          if (cancelRef.current && done.length < chain.length) {
            setResultNote(`已取消：先完成的 ${done.length} 件保留在结果里。`);
          }
        }
        chainLockRef.current = false;
      }
      return;
    }

    chainLockRef.current = true;
    cancelRef.current = false;
    setResultNote(null);
    setError(null);
    setGenerating(true);
    setResultUrl(null);
    setResultTaskId(null);
    setCompletedSteps([]);
    setVideoUrl(null);
    setWaitedSeconds(0);

    let currentPhoto = photoUrl;
    const done: { label: string; url: string }[] = [];

    try {
      for (let index = 0; index < chain.length; index += 1) {
        if (cancelRef.current) break;
        const garment = chain[index];
        if (!aliveRef.current) return;
        setStep({
          index: index + 1,
          total: chain.length,
          garment,
          label: `${ROLE_LABEL[roleOf(garment)]} · ${garment.name}`,
          previewUrl: currentPhoto,
        });
        setStageLabel(index === 0 ? '正在生成试穿效果' : `正在叠加第 ${index + 1} 件`);

        const taskId = await createTryonTask(currentPhoto, garment.id);
        if (!aliveRef.current) return;
        setResultTaskId(taskId);
        void saveInflight({
          taskId,
          kind: 'tryon',
          label: `${ROLE_LABEL[roleOf(garment)]} · ${garment.name}`,
          startedAt: Date.now(),
        });

        const url = await pollTryon(taskId);
        if (!aliveRef.current) return;
        if (!url) {
          // 取消时提前出循环：已完成的那几件留在结果区
          if (cancelRef.current) break;
          return;
        }

        currentPhoto = url;
        done.push({ label: garment.name, url });
        setCompletedSteps([...done]);
        setResultUrl(url);
        void clearInflight();
      }
      setStageLabel('');
    } catch (err) {
      if (aliveRef.current) setError(toUserMessage(err, '试衣生成失败，请重试'));
    } finally {
      if (aliveRef.current) {
        setGenerating(false);
        setStep(null);
        setStageLabel('');
        if (cancelRef.current && done.length < chain.length) {
          setResultNote(
            done.length
              ? `已取消：先完成的 ${done.length} 件保留在结果里，剩下的可以稍后重试。`
              : '已取消。那一件可能仍在后台生成，稍后到「我的」看看。',
          );
        }
      }
      chainLockRef.current = false;
    }
  };

  const cancelTryon = () => {
    if (!generating) return;
    cancelRef.current = true;
    setStageLabel('正在取消…');
  };

  // 有背面平铺图的单品才能看背面；多层时取第一件有背面图的
  const backGarment = useMemo(() => chain.find((item) => Boolean(item.back_image_url)) ?? null, [chain]);

  // 还没有背面图的那一件：视频生成完之后可以把最后一帧存给它
  const backFrameGarment = useMemo(
    () => chain.find((item) => !item.back_image_url) ?? null,
    [chain],
  );

  const saveResultLocally = async () => {
    const url = videoUrl ?? resultUrl;
    if (!url) return;
    const kind = videoUrl ? 'video' : 'image';
    setSaveHint(null);
    const result = await saveRemoteFile(url, suggestFilename(kind, resultTaskId), kind);
    setSaveHint(result.message);
  };

  const saveBackFromVideo = async () => {
    if (!videoUrl || !backFrameGarment) return;
    if (savingBack) return;
    setSavingBack(true);
    setError(null);
    setBackSavedHint(null);
    try {
      const dataUrl = await captureLastFrame(videoUrl);
      if (!dataUrl) {
        setBackSavedHint('没能从视频里取到画面（可能是浏览器跨域限制），可以稍后重试。');
        return;
      }
      const result = await saveBackFrame(backFrameGarment.id, dataUrl);
      if (!result.ok) {
        setBackSavedHint(result.message);
        return;
      }
      setGarments((prev) =>
        prev.map((item) => (item.id === backFrameGarment.id ? { ...item, back_image_url: result.backImageUrl } : item)),
      );
      setBackSavedHint(`已存为「${backFrameGarment.name}」的背面素材，下次可以在结果里点「看背面实物图」。`);
    } catch (err) {
      setBackSavedHint(toUserMessage(err, '保存背面素材失败，请稍后重试'));
    } finally {
      setSavingBack(false);
    }
  };

  const pollVideo = async (taskId: string) => {
    const startedAt = Date.now();
    let pollErrors = 0;
    while (Date.now() - startedAt < MAX_VIDEO_WAIT_MS) {
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      if (!aliveRef.current) return null;
      try {
        const task = await fetchVideoTask(taskId);
        pollErrors = 0;
        if (task.status === 'done' && task.result_url) return task.result_url;
        if (task.status === 'failed' || task.status === 'timeout') {
          throw new Error(task.error_msg || '视频生成失败，请重试');
        }
      } catch (err) {
        if (err instanceof Error && /视频|失败|超时/.test(err.message)) throw err;
        pollErrors += 1;
        if (pollErrors >= MAX_POLL_ERRORS) throw new Error('网络不稳定，视频状态查询中断，请稍后重试');
      }
    }
    throw new Error('视频生成超时，请稍后重试');
  };

  const startVideo = async () => {
    if (videoLockRef.current) return;

    // 演示模式：等一小会儿直接播放预生成的真实视频（现场不用排队等 20 分钟）
    if (DEMO_MODE) {
      videoLockRef.current = true;
      setGeneratingVideo(true);
      setVideoUrl(null);
      setVideoWaited(0);
      setError(null);
      try {
        await new Promise((resolve) => setTimeout(resolve, DEMO_VIDEO_MS));
        if (aliveRef.current) {
          setVideoUrl(DEMO_VIDEO);
          setResultNote(`${DEMO_BADGE}：这段 5 秒视频同样是真实生成过的，含转身定格背面。`);
        }
      } finally {
        if (aliveRef.current) setGeneratingVideo(false);
        videoLockRef.current = false;
      }
      return;
    }

    // 真实链路：没有任务号就提示（演示模式在上面已经提前返回）
    if (!resultTaskId) {
      setError('先生成试穿图，再生成视频');
      return;
    }

    videoLockRef.current = true;
    setGeneratingVideo(true);
    setVideoUrl(null);
    setVideoWaited(0);
    setError(null);

    try {
      await createVideoTask(resultTaskId, selectedPoseId, { background: videoBackground });
      // 视频动辄排队十几二十分钟，必须记下来，否则用户切走再回来就找不到这条了
      void saveInflight({ taskId: resultTaskId, kind: 'video', label: '穿搭视频', startedAt: Date.now() });
      const url = await pollVideo(resultTaskId);
      if (url && aliveRef.current) {
        setVideoUrl(url);
        void clearInflight();
      }
    } catch (err) {
      if (aliveRef.current) setError(toUserMessage(err, '视频生成失败，请重试'));
    } finally {
      if (aliveRef.current) setGeneratingVideo(false);
      videoLockRef.current = false;
    }
  };

  const submitPublish = async () => {
    if (!resultUrl) return;
    setPublishing(true);
    setError(null);
    try {
      // 关联第一件单品：首页看到这张图的人点「试穿同款」就能直接进同一件衣服
      await publishInspirationFromUrl({
        sourceUrl: resultUrl,
        caption: publishCaption,
        garmentId: chain[0]?.id ?? null,
      });
      if (!aliveRef.current) return;
      setPublishSheetVisible(false);
      setPublishCaption('');
      setPublished(true);
    } catch (err) {
      if (aliveRef.current) setError(toUserMessage(err, '发布失败，请稍后重试'));
    } finally {
      if (aliveRef.current) setPublishing(false);
    }
  };

  useEffect(() => {
    if (!autoVideoRef.current) return;
    if (!resultUrl || !resultTaskId || generating || generatingVideo) return;
    autoVideoRef.current = false;
    void startVideo();
    // startVideo 每次渲染都是新引用，放进依赖会重复触发，这里刻意只依赖状态
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resultUrl, resultTaskId, generating, generatingVideo]);

  const selectedPose = poses.find((pose) => pose.id === selectedPoseId) ?? null;
  const busy = generating || generatingVideo;

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <Text style={styles.eyebrow}>AI 穿搭管家</Text>
        <Text style={styles.title}>虚拟试衣</Text>
        <Text style={styles.subtitle}>
          上传一张全身照，选 1–3 件单品，按「上装 → 外套 → 下装」顺序逐件叠加。
        </Text>
        {DEMO_MODE ? (
          <View style={styles.demoBadge}>
            <AppIcon name="info" size={12} color={colors.muted} />
            <Text style={styles.demoBadgeText}>
              演示模式：试穿与视频直接给预生成的真实样例，不调用 AI、不消耗额度
            </Text>
          </View>
        ) : null}

        {/* 1. 全身照 */}
        <View style={styles.section}>
          <View style={styles.sectionHead}>
            <Text style={styles.stepIndex}>01</Text>
            <Text style={styles.sectionTitle}>你的全身照</Text>
          </View>
          <Pressable onPress={() => void choosePhoto()} style={styles.photoBox} disabled={busy}>
            {photoView ? (
              <View style={styles.photoPreview}>
                <Image source={{ uri: photoView }} style={styles.photoImage} resizeMode="contain" />
                <View style={styles.photoBadge}>
                  <AppIcon name="check" size={12} color={colors.onImage} />
                  <Text style={styles.photoBadgeText}>已上传 · 点击更换</Text>
                </View>
              </View>
            ) : (
              <View style={styles.photoEmpty}>
                {uploading ? (
                  <ActivityIndicator color={colors.muted} />
                ) : (
                  <AppIcon name="camera" size={22} color={colors.muted} />
                )}
                <Text style={styles.photoTitle}>{uploading ? '正在上传…' : '选择全身照'}</Text>
                <Text style={styles.photoHint}>正面站立、光线充足、身体不被遮挡</Text>
              </View>
            )}
          </Pressable>
        </View>

        {/* 2. 选衣服 */}
        <View style={styles.section}>
          <View style={styles.sectionHead}>
            <Text style={styles.stepIndex}>02</Text>
            <Text style={styles.sectionTitle}>选择单品</Text>
            <Text style={styles.sectionMeta}>{selectedIds.length}/{MAX_STEPS}</Text>
          </View>

          <Pressable onPress={applyTodayLook} style={styles.autoLook} hitSlop={8}>
            <AppIcon name="stylist" size={14} color={colors.text} />
            <Text style={styles.autoLookText}>用今日搭配</Text>
          </Pressable>

          {params.lookTitle ? (
            <View style={styles.lookBanner}>
              <AppIcon name="stylist" size={14} color={colors.text} />
              <Text style={styles.lookBannerText}>
                {`来自搭配「${params.lookTitle}」，会按上装 → 外套 → 下装顺序逐件叠加`}
              </Text>
            </View>
          ) : null}

          <View style={styles.searchBox}>
            <AppIcon name="search" size={15} color={colors.muted} />
            <TextInput
              value={searchText}
              onChangeText={setSearchText}
              placeholder="搜索名称、分类或颜色"
              placeholderTextColor={colors.muted}
              style={styles.searchInput}
            />
            {searchText ? (
              <Pressable onPress={() => setSearchText('')} hitSlop={8}>
                <AppIcon name="close" size={15} color={colors.muted} />
              </Pressable>
            ) : null}
          </View>

          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
            {CATEGORIES.map((category) => {
              const active = activeCategory === category;
              return (
                <Pressable
                  key={category}
                  onPress={() => setActiveCategory(category)}
                  style={[styles.chip, active && styles.chipActive]}
                >
                  <Text style={[styles.chipText, active && styles.chipTextActive]}>{category}</Text>
                </Pressable>
              );
            })}
          </ScrollView>

          {chain.length > 0 ? (
            <View style={styles.chainRow}>
              {chain.map((garment, index) => (
                <View key={garment.id} style={styles.chainChip}>
                  <Text style={styles.chainChipText}>
                    {index + 1}. {ROLE_LABEL[roleOf(garment)]} {garment.name}
                  </Text>
                  <Pressable onPress={() => toggleGarment(garment)} hitSlop={6}>
                    <AppIcon name="close" size={12} color={colors.muted} />
                  </Pressable>
                </View>
              ))}
            </View>
          ) : null}

          {loadingGarments ? (
            <View style={styles.listState}>
              <ActivityIndicator color={colors.muted} />
              <Text style={styles.listStateText}>正在读取衣橱…</Text>
            </View>
          ) : loadError ? (
            <View style={styles.listState}>
              <Text style={styles.listStateText}>{loadError}</Text>
              <Pressable onPress={() => void loadGarments()} style={styles.retryButton}>
                <Text style={styles.retryText}>重新加载</Text>
              </Pressable>
            </View>
          ) : filtered.length === 0 ? (
            <View style={styles.listState}>
              <Text style={styles.listStateText}>没有符合条件的单品</Text>
            </View>
          ) : (
            <View style={styles.grid}>
              {filtered.map((garment) => {
                const order = chain.findIndex((item) => item.id === garment.id);
                const active = order >= 0;
                return (
                  <Pressable
                    key={garment.id}
                    onPress={() => toggleGarment(garment)}
                    style={[styles.garmentCard, active && styles.garmentCardActive]}
                  >
                    <Image
                      source={{ uri: garment.flat_image_url || garment.model_image_url || undefined }}
                      style={styles.garmentImage}
                    />
                    {active ? (
                      <View style={styles.garmentOrder}>
                        <Text style={styles.garmentOrderText}>{order + 1}</Text>
                      </View>
                    ) : null}
                    <View style={styles.garmentMeta}>
                      <Text style={styles.garmentName} numberOfLines={1}>
                        {garment.name}
                      </Text>
                      <Text style={styles.garmentSub} numberOfLines={1}>
                        {garment.category}
                        {garment.color ? ` · ${garment.color}` : ''}
                      </Text>
                    </View>
                  </Pressable>
                );
              })}
            </View>
          )}
        </View>

        {error ? (
          <View style={styles.errorBox}>
            <AppIcon name="info" size={14} color={colors.danger} />
            <Text style={styles.errorText}>{error}</Text>
          </View>
        ) : null}

        {generating ? (
          <View style={styles.progressBox}>
            <View style={styles.progressHead}>
              <Text style={styles.progressTitle}>
                {step ? `第 ${step.index}/${step.total} 件` : '生成中'}
              </Text>
              <Text style={styles.progressTime}>{waitedSeconds}s</Text>
            </View>
            {step ? (
              <>
                <Text style={styles.progressLabel}>{step.label}</Text>
                <View style={styles.progressTrack}>
                  <View
                    style={[
                      styles.progressFill,
                      {
                        width: `${Math.min(
                          100,
                          ((step.index - 1 + Math.min(waitedSeconds / 60, 0.95)) / step.total) * 100,
                        )}%`,
                      },
                    ]}
                  />
                </View>
                <View style={styles.progressFoot}>
                  <Text style={styles.progressHint}>{stageLabel} · 单张约需 40–70 秒</Text>
                  <Pressable onPress={cancelTryon} hitSlop={10} style={styles.cancelButton}>
                    <Text style={styles.cancelText}>取消</Text>
                  </Pressable>
                </View>
              </>
            ) : null}
          </View>
        ) : null}

        {/* 3. 结果 */}
        {resultUrl ? (
          <View style={styles.resultBlock}>
            <View style={styles.sectionHead}>
              <Text style={styles.stepIndex}>03</Text>
              <Text style={styles.sectionTitle}>试穿结果</Text>
            </View>
            <Image source={{ uri: resultUrl }} style={styles.resultImage} resizeMode="cover" />
            {resultNote ? <Text style={styles.resultNote}>{resultNote}</Text> : null}
            {backGarment ? (
              <>
                <Pressable
                  onPress={() => setShowBackRef((current) => !current)}
                  style={styles.backButton}
                >
                  <AppIcon name="swap" size={15} color={colors.text} />
                  <Text style={styles.videoButtonText}>
                    {showBackRef ? '收起背面实物图' : '看背面实物图'}
                  </Text>
                </Pressable>
                {showBackRef ? (
                  <View style={styles.backRefBlock}>
                    <Image
                      source={{ uri: backGarment.back_image_url as string }}
                      style={styles.backRefImage}
                      resizeMode="contain"
                    />
                    <Text style={styles.backRefNote}>
                      实物背面图 · 由「{backGarment.name}」的素材提供。AI 试穿只还原正面视角，背面细节以这张实物图为准。
                    </Text>
                  </View>
                ) : null}
              </>
            ) : null}
            {completedSteps.length > 1 ? (
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.stepStrip}>
                {completedSteps.map((item, index) => (
                  // 演示模式下样例图会循环复用，同一 url 可能出现两次，
                  // 用 index 参与 key，避免 React 报 "two children with the same key"
                  <View key={`${index}-${item.label}`} style={styles.stepThumb}>
                    <Image source={{ uri: item.url }} style={styles.stepThumbImage} />
                    <Text style={styles.stepThumbLabel} numberOfLines={1}>
                      {item.label}
                    </Text>
                  </View>
                ))}
              </ScrollView>
            ) : null}

            <View style={styles.videoHead}>
              <Text style={styles.sectionTitle}>换成动态</Text>
              <Pressable onPress={() => setPoseSheetVisible(true)}>
                <Text style={styles.linkText}>{selectedPose ? selectedPose.name : '选姿势'}</Text>
              </Pressable>
            </View>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.bgRow}>
              {BG_OPTIONS.map((option) => {
                const active = option.id === videoBackground;
                return (
                  <Pressable
                    key={option.id}
                    onPress={() => setVideoBackground(option.id)}
                    style={[styles.bgChip, active && styles.bgChipActive]}
                  >
                    <Text style={[styles.bgChipText, active && styles.bgChipTextActive]}>{option.label}</Text>
                  </Pressable>
                );
              })}
            </ScrollView>
            {videoBackground !== 'keep' ? (
              <Text style={styles.bgHint}>换背景会让模型重绘整幅画面，人物与衣服有轻微走样的可能；发布前建议先试一版。</Text>
            ) : null}
            <Pressable
              onPress={() => void startVideo()}
              disabled={generatingVideo}
              style={[styles.videoButton, generatingVideo && styles.videoButtonDisabled]}
            >
              {generatingVideo ? (
                <>
                  <ActivityIndicator size="small" color={colors.text} />
                  <Text style={styles.videoButtonText}>生成中 · {videoWaited}s</Text>
                </>
              ) : (
                <>
                  <AppIcon name="video" size={15} color={colors.text} />
                  <Text style={styles.videoButtonText}>{videoUrl ? '重新生成视频' : '生成穿搭视频'}</Text>
                </>
              )}
            </Pressable>
            {generatingVideo ? (
              <Text style={styles.videoHint}>
                视频通常需要 3–20 分钟，可以先去别的页面，稍后回「我的」看这条记录。
              </Text>
            ) : null}
            {videoUrl ? <ResultVideo uri={videoUrl} /> : null}
            {videoUrl && CAN_CAPTURE_FRAME && backFrameGarment && !DEMO_MODE ? (
              <>
                <Pressable
                  onPress={() => void saveBackFromVideo()}
                  disabled={savingBack}
                  style={[styles.videoButton, savingBack && styles.videoButtonDisabled]}
                >
                  {savingBack ? (
                    <>
                      <ActivityIndicator size="small" color={colors.text} />
                      <Text style={styles.videoButtonText}>正在保存背面素材…</Text>
                    </>
                  ) : (
                    <>
                      <AppIcon name="swap" size={15} color={colors.text} />
                      <Text style={styles.videoButtonText}>把最后一帧存为背面素材</Text>
                    </>
                  )}
                </Pressable>
                <Text style={styles.publishHint}>
                  {`视频最后一帧就是「${backFrameGarment.name}」的真实背面，存下来之后下次点「看背面实物图」就能看到它。`}
                </Text>
              </>
            ) : null}
            {backSavedHint ? <Text style={styles.publishHint}>{backSavedHint}</Text> : null}

            <Pressable
              onPress={() => setPublishSheetVisible(true)}
              style={[styles.videoButton, published && styles.videoButtonDisabled]}
              disabled={published}
            >
              <AppIcon name={published ? 'check' : 'share'} size={15} color={colors.text} />
              <Text style={styles.videoButtonText}>{published ? '已发布到首页' : '发布到首页'}</Text>
            </Pressable>
            <Text style={styles.publishHint}>
              发布后所有人都能在首页看到这套搭配；全身照不会公开，只有这张结果图会。
            </Text>

            <Pressable onPress={() => void saveResultLocally()} style={styles.saveButton}>
              <AppIcon name="download" size={15} color={colors.text} />
              <Text style={styles.videoButtonText}>{videoUrl ? '保存视频到本地' : '保存图片到本地'}</Text>
            </Pressable>
            {saveHint ? <Text style={styles.publishHint}>{saveHint}</Text> : null}
          </View>
        ) : null}

        <Pressable
          onPress={() => void startTryon()}
          disabled={busy || !photoUrl || chain.length === 0}
          style={[styles.cta, (busy || !photoUrl || chain.length === 0) && styles.ctaDisabled]}
        >
          {generating ? (
            <Text style={styles.ctaText}>生成中…</Text>
          ) : (
            <Text style={styles.ctaText}>
              {resultUrl ? '再试一次' : chain.length > 1 ? `依次试穿 ${chain.length} 件` : '生成试穿效果'}
            </Text>
          )}
        </Pressable>

        <Text style={styles.privacy}>照片仅用于本次生成，发布到社区需要你手动操作。</Text>
      </ScrollView>

      <Modal
        visible={publishSheetVisible}
        transparent
        animationType="slide"
        onRequestClose={() => setPublishSheetVisible(false)}
      >
        <Pressable style={styles.backdrop} onPress={() => setPublishSheetVisible(false)} />
        <View style={styles.sheet}>
          <View style={styles.sheetHandle} />
          <Text style={styles.sheetTitle}>发布这套搭配</Text>
          <TextInput
            value={publishCaption}
            onChangeText={setPublishCaption}
            placeholder="写一句搭配心得（可选）"
            placeholderTextColor={colors.muted}
            style={styles.captionInput}
            maxLength={120}
            multiline
          />
          <View style={styles.publishRow}>
            <Pressable onPress={() => setPublishSheetVisible(false)} style={styles.publishCancel}>
              <Text style={styles.publishCancelText}>取消</Text>
            </Pressable>
            <Pressable
              onPress={() => void submitPublish()}
              disabled={publishing}
              style={[styles.publishConfirm, publishing && styles.videoButtonDisabled]}
            >
              {publishing ? (
                <ActivityIndicator size="small" color={colors.background} />
              ) : (
                <Text style={styles.publishConfirmText}>发布</Text>
              )}
            </Pressable>
          </View>
        </View>
      </Modal>

      <Modal visible={poseSheetVisible} transparent animationType="slide" onRequestClose={() => setPoseSheetVisible(false)}>
        <Pressable style={styles.backdrop} onPress={() => setPoseSheetVisible(false)} />
        <View style={styles.sheet}>
          <View style={styles.sheetHandle} />
          <Text style={styles.sheetTitle}>选择展示姿势</Text>
          {poses.length === 0 ? (
            <Text style={styles.sheetEmpty}>暂无可选姿势，将使用默认姿态</Text>
          ) : (
            <>
            <ScrollView
              style={styles.poseScroll}
              contentContainerStyle={styles.poseGrid}
              showsVerticalScrollIndicator={false}
            >
              {poses.map((pose, index) => {
                const active = pose.id === selectedPoseId;
                return (
                  <Pressable
                    key={pose.id}
                    onPress={() => {
                      setSelectedPoseId(active ? null : pose.id);
                      setPoseSheetVisible(false);
                    }}
                    style={[styles.poseCard, active && styles.poseCardActive]}
                  >
                    <View style={styles.poseThumb}>
                      {pose.image_url ? (
                        <Image source={{ uri: pose.image_url }} style={styles.poseThumbImage} resizeMode="cover" />
                      ) : (
                        <Image
                          source={POSE_DIAGRAMS[index % POSE_DIAGRAMS.length]}
                          style={styles.poseThumbImage}
                          resizeMode="cover"
                        />
                      )}
                      {active ? (
                        <View style={styles.poseCheck}>
                          <AppIcon name="check" size={11} color={colors.onImage} />
                        </View>
                      ) : null}
                    </View>
                    <Text style={styles.poseName} numberOfLines={1}>{pose.name}</Text>
                  </Pressable>
                );
              })}
            </ScrollView>
            <Text style={styles.sheetHint}>每个姿势对应一套独立的提示词模板，选哪个就按哪套生成。</Text>
            </>
          )}
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const makeStyles = (theme: Theme) => {
  const { colors, spacing, radius, type, button, chip, nav, card } = theme;
  const inset = (nav.floating ? nav.height + 28 : spacing.xl) as number;

  return StyleSheet.create({
    safe: { flex: 1, backgroundColor: colors.background },
    content: { paddingHorizontal: spacing.md, paddingTop: spacing.xs, paddingBottom: inset, gap: spacing.md },
    eyebrow: { ...type.label, color: colors.muted, letterSpacing: 1.4 },
    title: { ...type.display, fontSize: 30, lineHeight: 36 },
    subtitle: { ...type.caption, color: colors.muted, lineHeight: 18, marginTop: -6 },
    demoBadge: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      paddingVertical: 7,
      paddingHorizontal: 10,
      borderRadius: radius.md,
      backgroundColor: colors.surfaceAlt,
    },
    demoBadgeText: { ...type.caption, color: colors.muted, flex: 1, lineHeight: 16 },

    section: { gap: spacing.sm },
    sectionHead: { flexDirection: 'row', alignItems: 'baseline', gap: 8 },
    stepIndex: { ...type.label, color: colors.muted, fontSize: 10 },
    sectionTitle: { ...type.section, color: colors.text, flex: 1 },
    sectionMeta: { ...type.label, color: colors.muted },
    autoLook: {
      flexDirection: 'row',
      alignItems: 'center',
      alignSelf: 'flex-start',
      gap: 6,
      paddingHorizontal: spacing.md,
      paddingVertical: 7,
      borderRadius: radius.pill,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.surface,
    },
    autoLookText: { ...type.caption, color: colors.text },
    lookBanner: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.xs,
      paddingVertical: spacing.sm,
      paddingHorizontal: spacing.sm,
      borderRadius: radius.sm,
      backgroundColor: colors.accentSoft,
    },
    lookBannerText: { ...type.caption, color: colors.text, flex: 1 },

    photoBox: {
      borderWidth: 1,
      borderStyle: 'dashed',
      borderColor: colors.border,
      borderRadius: card.radius,
      overflow: 'hidden',
      backgroundColor: colors.surface,
    },
    photoEmpty: { alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: 26 },
    photoTitle: { ...type.body, fontWeight: '600', color: colors.text },
    photoHint: { ...type.caption, color: colors.muted },
    photoPreview: { height: 260, backgroundColor: colors.surfaceAlt },
    photoImage: { width: '100%', height: '100%' },
    photoBadge: {
      position: 'absolute',
      left: 10,
      bottom: 10,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 5,
      backgroundColor: 'rgba(17,17,19,0.6)',
      paddingHorizontal: 9,
      paddingVertical: 5,
      borderRadius: 999,
    },
    photoBadgeText: { ...type.label, color: colors.onImage, fontSize: 9 },

    searchBox: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      backgroundColor: colors.surfaceAlt,
      borderRadius: radius.md,
      paddingHorizontal: 12,
      height: 44,
    },
    searchInput: { flex: 1, ...type.body, color: colors.text, height: '100%' },
    chips: { gap: 8, paddingVertical: 2 },
    chip: {
      paddingHorizontal: 14,
      paddingVertical: 8,
      borderRadius: chip.radius,
      borderWidth: 1,
      borderColor: chip.borderColor,
      backgroundColor: chip.background,
    },
    chipActive: { backgroundColor: chip.activeBackground ?? colors.accent, borderColor: colors.accent },
    chipText: { ...type.label, color: chip.color, letterSpacing: 0.4 },
    chipTextActive: { color: chip.activeColor ?? colors.onImage },

    chainRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
    chainChip: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      paddingHorizontal: 9,
      paddingVertical: 6,
      borderRadius: radius.pill,
      backgroundColor: colors.surfaceAlt,
    },
    chainChipText: { ...type.caption, color: colors.text, fontSize: 11 },

    listState: { alignItems: 'center', gap: 8, paddingVertical: 24 },
    listStateText: { ...type.caption, color: colors.muted, textAlign: 'center' },
    retryButton: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: radius.pill, backgroundColor: colors.surfaceAlt },
    retryText: { ...type.label, color: colors.text },

    grid: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', gap: 12 },
    garmentCard: {
      width: '47.5%',
      borderRadius: card.radius,
      overflow: 'hidden',
      backgroundColor: colors.surface,
      borderWidth: 1,
      borderColor: colors.border,
    },
    garmentCardActive: { borderColor: colors.accent, borderWidth: 1.5 },
    garmentImage: { width: '100%', aspectRatio: 0.82, backgroundColor: colors.surfaceAlt },
    garmentOrder: {
      position: 'absolute',
      top: 8,
      right: 8,
      width: 22,
      height: 22,
      borderRadius: 11,
      backgroundColor: colors.accent,
      alignItems: 'center',
      justifyContent: 'center',
    },
    garmentOrderText: { ...type.label, color: colors.onImage, fontSize: 10 },
    garmentMeta: { padding: 9, gap: 2 },
    garmentName: { ...type.body, fontWeight: '600', color: colors.text, fontSize: 12 },
    garmentSub: { ...type.caption, color: colors.muted, fontSize: 10 },

    errorBox: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: 7,
      padding: 11,
      borderRadius: radius.md,
      backgroundColor: colors.surfaceAlt,
    },
    errorText: { ...type.caption, color: colors.danger, flex: 1, lineHeight: 17 },

    progressBox: {
      gap: 8,
      padding: 14,
      borderRadius: card.radius,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.surface,
    },
    progressHead: { flexDirection: 'row', justifyContent: 'space-between' },
    progressTitle: { ...type.section, color: colors.text },
    progressTime: { ...type.caption, color: colors.muted },
    progressLabel: { ...type.body, color: colors.text, fontSize: 12 },
    progressTrack: { height: 3, borderRadius: 2, backgroundColor: colors.surfaceAlt, overflow: 'hidden' },
    progressFill: { height: '100%', backgroundColor: colors.accent },
    progressFoot: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
    cancelButton: {
      paddingHorizontal: spacing.sm,
      paddingVertical: 4,
      borderRadius: radius.pill,
      borderWidth: 1,
      borderColor: colors.border,
    },
    cancelText: { ...type.caption, color: colors.muted },
    progressHint: { ...type.caption, color: colors.muted, fontSize: 10 },

    resultBlock: { gap: spacing.sm },
    resultImage: { width: '100%', height: 420, borderRadius: card.radius, backgroundColor: colors.surfaceAlt },
    resultNote: { ...type.caption, color: colors.muted, lineHeight: 17 },
    backRefBlock: { marginTop: spacing.sm, gap: 8 },
    backRefImage: {
      width: '100%',
      height: 320,
      borderRadius: radius.md,
      backgroundColor: colors.surfaceAlt,
    },
    backRefNote: { ...type.caption, color: colors.muted, lineHeight: 17 },
    backButton: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: spacing.xs,
      minHeight: 40,
      borderRadius: button.radius,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.surface,
    },
    stepStrip: { gap: 8 },
    stepThumb: { width: 76, gap: 4 },
    stepThumbImage: { width: 76, height: 100, borderRadius: radius.sm, backgroundColor: colors.surfaceAlt },
    stepThumbLabel: { ...type.caption, fontSize: 9, color: colors.muted },

    videoHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
    linkText: { ...type.label, color: colors.text, textDecorationLine: 'underline' },
    videoButton: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 8,
      height: 46,
      borderRadius: button.radius,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.surface,
    },
    videoButtonDisabled: { opacity: 0.6 },
    saveButton: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 8,
      paddingVertical: 13,
      borderRadius: radius.pill,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.surface,
      marginTop: spacing.xs,
    },
    publishHint: { ...type.caption, color: colors.muted, marginTop: spacing.xs, lineHeight: 17 },
    captionInput: {
      minHeight: 84,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.surface,
      padding: spacing.sm,
      marginTop: spacing.sm,
      ...type.body,
      color: colors.text,
      textAlignVertical: 'top',
    },
    publishRow: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.md },
    publishCancel: {
      flex: 1,
      minHeight: 46,
      borderRadius: button.radius,
      borderWidth: 1,
      borderColor: colors.border,
      alignItems: 'center',
      justifyContent: 'center',
    },
    publishCancelText: { ...type.section, color: colors.muted },
    publishConfirm: {
      flex: 1,
      minHeight: 46,
      borderRadius: button.radius,
      backgroundColor: button.background,
      alignItems: 'center',
      justifyContent: 'center',
    },
    publishConfirmText: { ...type.section, color: button.color },
    bgRow: { gap: spacing.xs, paddingVertical: spacing.xs },
    bgChip: {
      paddingHorizontal: spacing.md,
      paddingVertical: 7,
      borderRadius: radius.pill,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.surface,
    },
    bgChipActive: { backgroundColor: colors.text, borderColor: colors.text },
    bgChipText: { ...type.caption, color: colors.muted },
    bgChipTextActive: { color: colors.background },
    bgHint: { ...type.caption, color: colors.muted, lineHeight: 16 },
    poseScroll: { maxHeight: 340 },
    poseGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, paddingBottom: spacing.sm },
    poseCard: { width: '30%', gap: 6 },
    poseCardActive: { opacity: 1 },
    poseThumb: {
      width: '100%',
      aspectRatio: 0.78,
      borderRadius: radius.md,
      overflow: 'hidden',
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.surfaceAlt,
    },
    poseThumbImage: { width: '100%', height: '100%' },
    poseThumbEmpty: { flex: 1, alignItems: 'center', justifyContent: 'center' },
    poseCheck: {
      position: 'absolute',
      right: 5,
      top: 5,
      width: 17,
      height: 17,
      borderRadius: 9,
      backgroundColor: colors.accent,
      alignItems: 'center',
      justifyContent: 'center',
    },
    sheetHint: { ...type.caption, color: colors.muted, paddingTop: spacing.xs },
    videoHint: { ...type.caption, color: colors.muted, marginTop: spacing.xs },
    videoButtonText: { ...type.body, fontWeight: '600', color: colors.text, fontSize: 12 },

    cta: {
      height: button.minHeight,
      borderRadius: button.radius,
      backgroundColor: button.background,
      alignItems: 'center',
      justifyContent: 'center',
    },
    ctaDisabled: { opacity: 0.35 },
    ctaText: { ...type.body, fontWeight: '700', color: button.color, letterSpacing: button.letterSpacing },
    privacy: { ...type.caption, color: colors.muted, textAlign: 'center', fontSize: 10 },

    backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.35)' },
    sheet: {
      backgroundColor: colors.background,
      borderTopLeftRadius: radius.lg,
      borderTopRightRadius: radius.lg,
      padding: spacing.md,
      paddingBottom: spacing.xl,
      gap: 10,
      maxHeight: '78%',
    },
    sheetHandle: { alignSelf: 'center', width: 38, height: 4, borderRadius: 2, backgroundColor: colors.border },
    sheetTitle: { ...type.title, color: colors.text },
    sheetEmpty: { ...type.caption, color: colors.muted },
    poseOption: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
      padding: 12,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: colors.border,
    },
    poseOptionActive: { borderColor: colors.accent },
    poseCopy: { flex: 1, gap: 2 },
    poseName: { ...type.body, fontWeight: '600', color: colors.text },
    poseDesc: { ...type.caption, color: colors.muted },
  });
};
