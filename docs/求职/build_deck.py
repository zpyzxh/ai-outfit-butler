# -*- coding: utf-8 -*-
"""生成《AI 穿搭管家》面试讲解 PPT。

设计语言与 App 的 runway 主题一致：纯白底、近黑正文、极细分割线、
衬线大标题 + 小字号宽字距的小标题（eyebrow），尽量少用颜色块。
"""
from pathlib import Path

from pptx import Presentation
from pptx.dml.color import RGBColor
from pptx.enum.shapes import MSO_SHAPE
from pptx.enum.text import MSO_ANCHOR, PP_ALIGN
from pptx.util import Emu, Inches, Pt

OUT = Path(__file__).with_name("03-面试讲解-12页.pptx")

# ---------- 设计 token ----------
INK = RGBColor(0x11, 0x11, 0x13)
MUTED = RGBColor(0x6B, 0x6B, 0x70)
FAINT = RGBColor(0x9A, 0x9A, 0x9F)
HAIR = RGBColor(0xE9, 0xE9, 0xEC)
PAPER = RGBColor(0xFF, 0xFF, 0xFF)
WASH = RGBColor(0xF6, 0xF6, 0xF7)
ACCENT = RGBColor(0xB4, 0x86, 0x5E)  # 极少量暖棕，只用于强调数字/关键词

SERIF = "SimSun"
SONG = "SimSun"
SANS = "Microsoft YaHei"
NUM = "Georgia"

SLIDE_W = 13.333
SLIDE_H = 7.5
ML = 0.95          # 左边距
MR = 0.95          # 右边距
CW = round(SLIDE_W - ML - MR, 3)   # 内容宽 11.433


def new_deck() -> Presentation:
    deck = Presentation()
    deck.slide_width = Inches(SLIDE_W)
    deck.slide_height = Inches(SLIDE_H)
    return deck


def blank(deck: Presentation):
    return deck.slides.add_slide(deck.slide_layouts[6])


def _tracking(run, points: float):
    """python-pptx 没有字距 API，直接写 OOXML 的 spc（单位：1/100 磅）。"""
    run.font._rPr.set("spc", str(int(points * 100)))


def txt(slide, x, y, w, h, text, *, font=SANS, size=14, color=INK, bold=False,
        align=PP_ALIGN.LEFT, line=1.35, tracking=None, anchor=MSO_ANCHOR.TOP,
        italic=False):
    box = slide.shapes.add_textbox(Inches(x), Inches(y), Inches(w), Inches(h))
    frame = box.text_frame
    frame.word_wrap = True
    frame.margin_left = 0
    frame.margin_right = 0
    frame.margin_top = 0
    frame.margin_bottom = 0
    frame.vertical_anchor = anchor
    lines = text.split("\n")
    for index, line_text in enumerate(lines):
        para = frame.paragraphs[0] if index == 0 else frame.add_paragraph()
        para.alignment = align
        para.line_spacing = line
        run = para.add_run()
        run.text = line_text
        run.font.name = font
        run.font.size = Pt(size)
        run.font.bold = bold
        run.font.italic = italic
        run.font.color.rgb = color
        if tracking:
            _tracking(run, tracking)
    return box


def rule(slide, x, y, w, *, color=HAIR, weight=1.0):
    line = slide.shapes.add_shape(MSO_SHAPE.RECTANGLE, Inches(x), Inches(y),
                                  Inches(w), Emu(int(weight * 12700)))
    line.fill.solid()
    line.fill.fore_color.rgb = color
    line.line.fill.background()
    line.shadow.inherit = False
    return line


def block(slide, x, y, w, h, *, fill=WASH, line_color=None, radius=None):
    shape_type = MSO_SHAPE.ROUNDED_RECTANGLE if radius else MSO_SHAPE.RECTANGLE
    shape = slide.shapes.add_shape(shape_type, Inches(x), Inches(y), Inches(w), Inches(h))
    shape.fill.solid()
    shape.fill.fore_color.rgb = fill
    if line_color is None:
        shape.line.fill.background()
    else:
        shape.line.color.rgb = line_color
        shape.line.width = Pt(0.75)
    shape.shadow.inherit = False
    if radius:
        shape.adjustments[0] = radius
    return shape


def eyebrow(slide, text, *, x=ML, y=0.62, color=MUTED):
    return txt(slide, x, y, CW, 0.24, text, font=SANS, size=9.5, color=color, tracking=2.6)


def title(slide, text, *, x=ML, y=1.02, size=34, w=None, color=INK, font=SONG):
    return txt(slide, x, y, w or CW, 0.9, text, font=font, size=size, color=color, line=1.15)


def page_no(slide, index, total):
    txt(slide, SLIDE_W - MR - 0.9, SLIDE_H - 0.62, 0.9, 0.24, f"{index:02d} / {total:02d}",
        font=NUM, size=9.5, color=FAINT, align=PP_ALIGN.RIGHT, tracking=1.2)


def footer(slide, text):
    txt(slide, ML, SLIDE_H - 0.62, CW - 1.1, 0.24, text, font=SANS, size=9.5, color=FAINT)


def notes(slide, text):
    slide.notes_slide.notes_text_frame.text = text


def stat(slide, x, y, w, number, label, *, accent=False, size=34):
    txt(slide, x, y, w, 0.62, number, font=NUM, size=size,
        color=ACCENT if accent else INK, line=1.0)
    txt(slide, x, y + 0.66, w, 0.3, label, font=SANS, size=10.5, color=MUTED, line=1.2)


def rows_table(slide, x, y, w, headers, rows, *, col_ratios, row_h=0.52,
               head_color=MUTED, mark_col=None):
    """编辑风格的「表」：只画细线，不画格子。"""
    total = sum(col_ratios)
    widths = [w * r / total for r in col_ratios]
    xs = [x]
    for width in widths[:-1]:
        xs.append(round(xs[-1] + width, 3))

    for index, header in enumerate(headers):
        txt(slide, xs[index], y, widths[index] - 0.15, 0.26, header,
            font=SANS, size=9.5, color=head_color, tracking=1.6)
    rule(slide, x, y + 0.36, w)

    cursor = y + 0.46
    for row_index, row in enumerate(rows):
        for col_index, cell in enumerate(row):
            is_mark = mark_col is not None and col_index == mark_col
            txt(slide, xs[col_index], cursor, widths[col_index] - 0.18, row_h - 0.08,
                cell, font=SANS, size=11.5 if not is_mark else 11.5,
                color=INK if not is_mark else INK, bold=is_mark, line=1.25)
        cursor = round(cursor + row_h, 3)
        rule(slide, x, cursor - 0.1, w, color=HAIR)
    return cursor


# =====================================================================
# 12 页
# =====================================================================
def build():
    deck = new_deck()
    total = 12

    # ---------------- 01 封面 ----------------
    slide = blank(deck)
    eyebrow(slide, "CASE  STUDY   ·   AI  FASHION  TRY-ON   ·   2026", y=0.95)
    txt(slide, ML, 1.62, CW, 1.5, "AI 穿搭管家", font=SERIF, size=62, color=INK, line=1.1, bold=True)
    txt(slide, ML, 3.03, 8.4, 0.9,
        "把「看到一件喜欢的衣服」\n变成「看到自己穿上、并且动起来」",
        font=SONG, size=22, color=INK, line=1.5)
    rule(slide, ML, 4.66, CW)
    txt(slide, ML, 4.9, 5.6, 0.9,
        "Expo React Native · TypeScript · Supabase\nAidge 虚拟试衣 · 通义万相 图生视频",
        font=SANS, size=11.5, color=MUTED, line=1.7)
    txt(slide, SLIDE_W - MR - 4.2, 4.9, 4.2, 0.9,
        "求职作品集 · 面试讲解版\n12 页 / 讲完约 8 分钟",
        font=SANS, size=11.5, color=MUTED, align=PP_ALIGN.RIGHT, line=1.7)
    page_no(slide, 1, total)
    notes(slide, "开场 20 秒：这是一个能真正跑起来的时尚穿搭 App，四个能力——推荐搭配、整套试穿、"
                 "图生视频、发布成社区内容。我准备了三种讲法，先按全栈视角走一遍链路，"
                 "后面可以按你的岗位侧重重讲某几页。")

    # ---------------- 02 一页纸 ----------------
    slide = blank(deck)
    eyebrow(slide, "THE  ONE  SLIDE")
    title(slide, "一页看完")
    rule(slide, ML, 1.92, CW)

    txt(slide, ML, 2.16, 6.4, 1.5,
        "用户上传一张全身照，选 1–3 件单品，\n系统按「上装 → 外套 → 下装」逐件叠加试穿，\n"
        "再一键把结果变成 5 秒动态视频。",
        font=SANS, size=14.5, color=INK, line=1.85)

    stats = [
        ("3.8s", "穿搭问答首字返回"),
        ("40–70s", "单件试衣出图"),
        ("¥0.4", "单张试衣成本"),
        ("¥0.3", "一条 5 秒视频"),
    ]
    for index, (number, label) in enumerate(stats):
        stat(slide, ML + index * 2.92, 4.06, 2.6, number, label, accent=index in (2, 3))

    rule(slide, ML, 5.32, CW)
    txt(slide, ML, 5.52, CW, 1.2,
        "技术栈：Expo RN（iOS / Android / Web 同一套代码）+ Supabase（Postgres / Storage / Edge Functions）"
        "+ 两家 AI 供应商\n工程重心：多端一致的设计系统、私有存储与签名、失败路径与成本控制",
        font=SANS, size=11.5, color=MUTED, line=1.9)
    page_no(slide, 2, total)
    notes(slide, "这一页是「电梯陈述」：一句话说清做什么 + 四个数字说明规模与成本。"
                 "面试官只记得住数字，所以把 3.8s / 40–70s / ¥0.4 / ¥0.3 背熟。")

    # ---------------- 03 用户旅程 ----------------
    slide = blank(deck)
    eyebrow(slide, "USER  JOURNEY")
    title(slide, "四步闭环")
    rule(slide, ML, 1.92, CW)

    steps = [
        ("01", "看灵感", "满屏竖滑的社区灵感流\n看到喜欢的直接「试穿同款」"),
        ("02", "挑搭配", "基于衣橱 + 当日天气 + 风格档案\n每次生成 3 套，可换一批"),
        ("03", "整套试穿", "一次选 1–3 件，串行叠加\n中途可见 1/3、2/3 进度"),
        ("04", "出片 · 发布", "结果图一键变 5 秒视频\n发布到首页并关联单品"),
    ]
    card_w, gap = 2.62, 0.34
    for index, (no, head, body) in enumerate(steps):
        x = round(ML + index * (card_w + gap), 3)
        txt(slide, x, 2.3, 1.0, 0.4, no, font=NUM, size=13, color=ACCENT)
        txt(slide, x, 2.72, card_w, 0.42, head, font=SONG, size=21, color=INK)
        txt(slide, x, 3.24, card_w, 1.5, body, font=SANS, size=11, color=MUTED, line=1.75)

    rule(slide, ML, 4.94, CW)
    txt(slide, ML, 5.14, CW, 1.4,
        "设计取舍：把「好看的灵感」放在第一步而不是表单，是为了让冷启动阶段依然有内容可看；\n"
        "把「发布」放在最后一步，是为了给生成结果一个去向——否则用户看完图就走，没有留存钩子。",
        font=SANS, size=11.5, color=MUTED, line=1.9)
    page_no(slide, 3, total)
    notes(slide, "产品岗重点讲这页：四步对应四个钩子（新鲜感 → 决策辅助 → 沉没成本 → 社交货币）。"
                 "前端岗可以只花 10 秒带过，重点放到第 4、6、11 页。")

    # ---------------- 04 信息架构 ----------------
    slide = blank(deck)
    eyebrow(slide, "INFORMATION  ARCHITECTURE")
    title(slide, "把最贵的入口位让给最能打的功能")
    rule(slide, ML, 1.92, CW)

    # 旧
    txt(slide, ML, 2.22, 5.2, 0.3, "改版前", font=SANS, size=10, color=MUTED, tracking=2)
    old_tabs = ["首页", "对话", "发布", "试衣", "我的"]
    for index, tab in enumerate(old_tabs):
        x = round(ML + index * 0.98, 3)
        is_bad = tab == "对话"
        block(slide, x, 2.6, 0.86, 0.62, fill=INK if is_bad else PAPER,
              line_color=None if is_bad else HAIR)
        txt(slide, x, 2.78, 0.86, 0.3, tab, font=SANS, size=10.5,
            color=PAPER if is_bad else INK, align=PP_ALIGN.CENTER)
    txt(slide, ML, 3.34, 5.2, 0.5,
        "「对话」依赖外部模型服务，当时整条服务不可用，\n却占着一级入口", font=SANS, size=10.5, color=MUTED, line=1.6)

    # 新
    txt(slide, ML, 4.06, 5.2, 0.3, "改版后", font=SANS, size=10, color=MUTED, tracking=2)
    new_tabs = ["首页", "搭配", "发布", "试衣", "我的"]
    for index, tab in enumerate(new_tabs):
        x = round(ML + index * 0.98, 3)
        is_good = tab == "搭配"
        block(slide, x, 4.44, 0.86, 0.62, fill=INK if is_good else PAPER,
              line_color=None if is_good else HAIR)
        txt(slide, x, 4.62, 0.86, 0.3, tab, font=SANS, size=10.5,
            color=PAPER if is_good else INK, align=PP_ALIGN.CENTER)
    txt(slide, ML, 5.18, 5.2, 0.5, "「搭配」是唯一每天都有新内容、且不依赖对话服务的功能",
        font=SANS, size=10.5, color=MUTED, line=1.6)

    # 右侧理由
    reasons = [
        ("不是删功能，是降级", "「对话」从底栏移到搭配页底部入口，路由与代码都保留 —— 功能可用性恢复后随时能升回一级入口。"),
        ("一级入口只放稳定能力", "一个每天报错的入口，比一个没有入口的功能更伤体验；入口位置本质是「信任配额」。"),
        ("把链路缩到一次点击", "搭配页每套卡片上直接放「试穿这套 / 出视频」，用户不必先记住单品再跳页挑选。"),
    ]
    base_y = 2.22
    for index, (head, body) in enumerate(reasons):
        y = round(base_y + index * 1.62, 3)
        txt(slide, 7.0, y, 0.3, 0.3, f"{index + 1}", font=NUM, size=11, color=ACCENT)
        txt(slide, 7.36, y - 0.04, 5.02, 0.36, head, font=SANS, size=13, color=INK, bold=True)
        txt(slide, 7.36, y + 0.38, 5.02, 1.0, body, font=SANS, size=11, color=MUTED, line=1.8)
    rule(slide, 6.72, 2.22, 0.012, color=HAIR, weight=0.9)
    page_no(slide, 4, total)
    notes(slide, "这是整个项目里最像「产品经理」的一次决策，也是面试最好讲的一段："
                 "不是加功能，而是重新分配注意力。讲的时候强调「降级 ≠ 删除」，"
                 "体现的是对资源与信任的管理，而不是审美偏好。")

    # ---------------- 05 整套试穿 ----------------
    slide = blank(deck)
    eyebrow(slide, "CORE  FLOW")
    title(slide, "把「三件衣服」变成「一次操作」")
    rule(slide, ML, 1.92, CW)

    txt(slide, ML, 2.2, 5.6, 1.1,
        "商业试衣模型的输入永远是「一张人像 + 一件衣服」，\n做不了多件同时上。",
        font=SANS, size=12.5, color=MUTED, line=1.8)

    # 串行叠加示意
    labels = [("①", "上装", "人像 A + T恤 → 结果 A1"), ("②", "外套", "A1 + 西装 → 结果 A2"),
              ("③", "下装", "A2 + 裤装 → 结果 A3")]
    for index, (no, role, detail) in enumerate(labels):
        x = round(ML + index * 2.28, 3)
        block(slide, x, 3.46, 1.92, 1.16, fill=WASH)
        txt(slide, x + 0.2, 3.62, 1.5, 0.3, f"{no} {role}", font=SONG, size=15, color=INK)
        txt(slide, x + 0.2, 3.98, 1.6, 0.5, detail, font=SANS, size=9, color=MUTED, line=1.5)
        if index < 2:
            txt(slide, x + 1.96, 3.92, 0.3, 0.3, "→", font=NUM, size=14, color=FAINT)

    rule(slide, ML, 4.84, CW)
    txt(slide, ML, 5.02, 6.1, 1.6,
        "第 N 步把第 N-1 步的结果当作新的全身照传进去：试衣接口\n"
        "本来就只吃「一张人像 + 一件衣服」，所以整套试穿不需要新接口，\n"
        "前端串行调用即可；代价是 3 件约 3 分钟、¥1.2。",
        font=SANS, size=11.5, color=MUTED, line=1.9)

    for index, (number, label) in enumerate([("3", "一次最多件数"), ("¥1.2", "三件套成本"),
                                             ("3/10min", "设备限流上限")]):
        stat(slide, 7.55 + index * 1.62, 5.02, 1.6, number, label, size=24)
    page_no(slide, 5, total)
    notes(slide, "这段体现工程判断：不改后端先能用。要主动说出代价——时间与钱，"
                 "再给出后端化方案（advance-on-request：建任务只跑第 1 步，前端拿 next_action 继续），"
                 "这样面试官会认为你既务实又知道上限在哪。")

    # ---------------- 06 架构 ----------------
    slide = blank(deck)
    eyebrow(slide, "ARCHITECTURE")
    title(slide, "一条链路，四层边界")
    rule(slide, ML, 1.92, CW)

    layers = [
        ("客户端", "Expo RN · iOS / Android / Web", "设计系统 token · 分页灵感动线 · 签名 URL 缓存"),
        ("边缘函数", "Supabase Edge Functions (Deno)", "tryon · video · chat · garment-back · payment"),
        ("AI 供应商", "Aidge 试衣 · 通义万相 i2v · qwen-plus", "同步试衣 / 异步任务轮询 / OpenAI 兼容对话"),
        ("数据与存储", "Postgres + Storage（私有桶）", "RLS 按 owner 收口 · 恢复码 definer 函数"),
    ]
    for index, (name, stack, detail) in enumerate(layers):
        y = round(2.24 + index * 1.12, 3)
        txt(slide, ML, y, 1.5, 0.34, name, font=SONG, size=16, color=INK)
        txt(slide, ML + 1.62, y, 4.2, 0.34, stack, font=SANS, size=11, color=MUTED)
        txt(slide, ML + 5.9, y, 5.5, 0.34, detail, font=SANS, size=11, color=MUTED)
        rule(slide, ML, y + 0.66, CW)
        if index < len(layers) - 1:
            txt(slide, ML + 0.6, y + 0.7, 0.3, 0.3, "↓", font=NUM, size=12, color=FAINT)

    txt(slide, ML, 6.26, CW, 0.6,
        "边界原则：密钥只在边缘函数；前端只有 anon key；存储一律私有 + 现签地址；每一次外部调用都必须有超时与降级。",
        font=SANS, size=11, color=INK, line=1.6)
    page_no(slide, 6, total)
    notes(slide, "全栈岗的核心页。按「谁持有密钥 / 谁负责鉴权 / 谁负责重试」三条讲，"
                 "比逐层介绍技术名更有说服力。")

    # ---------------- 07 安全对照实验 ----------------
    slide = blank(deck)
    eyebrow(slide, "SECURITY   ·   CONTROLLED  EXPERIMENT")
    title(slide, "用两个匿名账号，证明一个洞真的存在")
    rule(slide, ML, 1.92, CW)

    txt(slide, ML, 2.14, 6.6, 0.6,
        "不靠读代码「感觉不安全」，而是拿两个新注册的匿名身份 A / B 做对照实验。",
        font=SANS, size=11.5, color=MUTED, line=1.6)

    headers = ["探针（B 的身份去操作 A 的资源）", "收口前", "收口后"]
    rows = [
        ["B 往 A 的照片目录上传", "200 成功写", "403 RLS 拒绝"],
        ["B 删除 A 的照片", "200 真删掉了", "403 Access denied"],
        ["未登录列出照片桶", "200，枚举到文件名", "200，返回空数组"],
        ["未登录读试穿任务表", "17 行（含他人照片）", "0 行"],
        ["B 读取 A 的试衣结果", "200", "400 对象不存在"],
    ]
    rows_table(slide, ML, 2.8, 8.3, headers, rows, col_ratios=[5.0, 2.2, 2.2], row_h=0.54)

    txt(slide, 9.6, 2.86, 2.8, 0.6, "根因", font=SANS, size=10, color=MUTED, tracking=2)
    txt(slide, 9.55, 3.14, 2.55, 2.6,
        "RLS 是「任一策略通过即放行」。\n旧版本里残留的宽策略没有被清理，"
        "新写的「仅本人可写」策略形同虚设 ——\n"
        "加上 anon 角色还留着全表写权限。",
        font=SANS, size=10.5, color=MUTED, line=1.85)

    rule(slide, ML, 5.72, CW)
    txt(slide, ML, 5.9, CW, 0.8,
        "修法：按表扫描并删除所有涉及这些桶的旧策略（不分命令），再按 owner 重建；"
        "写入收归 service_role，客户端不再有写权限。",
        font=SANS, size=11.5, color=INK, line=1.7)
    page_no(slide, 7, total)
    notes(slide, "这一页最容易被记住，因为它有「实验」而不是「概念」。"
                 "如果面试官问怎么保证安全，就指这一页：先证明洞存在，再证明洞被堵上，两次都用同一批探针。")

    # ---------------- 08 私有存储与签名 ----------------
    slide = blank(deck)
    eyebrow(slide, "STORAGE   ·   SIGNED  URLS")
    title(slide, "桶改成私有之后，链路必须跟着改")
    rule(slide, ML, 1.92, CW)

    steps = [
        ("照片入库", "写进私有桶，库里只存\n不含 token 的规范地址", "路径首段 = 用户 ID"),
        ("展示一次", "按需换 1 小时签名地址\n提前 5 分钟续签 + 并发去重", "同一张图只签一次"),
        ("发给供应商", "只在调用那一次换成签名地址\n服务端下载完即用", "签名地址免鉴权可 GET"),
        ("删除记录", "先删数据库行并确认影响 1 行\n再清存储，失败只降级为警告", "避免「文件没了行还在」"),
    ]
    card_w, gap = 2.62, 0.34
    for index, (head, body, note) in enumerate(steps):
        x = round(ML + index * (card_w + gap), 3)
        rule(slide, x, 2.26, card_w - 0.3, color=INK, weight=1.0)
        txt(slide, x, 2.4, card_w - 0.2, 0.32, head, font=SONG, size=16, color=INK)
        txt(slide, x, 2.82, card_w - 0.2, 1.2, body, font=SANS, size=10.5, color=MUTED, line=1.75)
        txt(slide, x, 3.96, card_w - 0.2, 0.5, note, font=SANS, size=9, color=ACCENT, line=1.5)

    rule(slide, ML, 4.62, CW)
    txt(slide, ML, 4.82, 6.4, 1.6,
        "为什么不是「把桶改成私有」就完事？\n"
        "供应商（试衣 / 图生视频）只能拿 URL 去下载图片；桶一私，它们全都 400。\n"
        "所以真正的解法是：库里存规范地址，只在「人看」和「机器取」的那一次签名。",
        font=SANS, size=11.5, color=INK, line=1.85)
    txt(slide, 7.6, 4.82, 4.9, 1.6,
        "验证方式：私有化后，公开直链返回 400 Bucket not found；\n"
        "签名地址不带任何鉴权头 GET 返回 200 image/jpeg；\n"
        "别人的任务签名返回 404（不泄露对象是否存在）。",
        font=SANS, size=10.5, color=MUTED, line=1.8)
    page_no(slide, 8, total)
    notes(slide, "这页回答「安全 vs 可用」的真实冲突：不是非黑即白，而是把信任边界挪到「谁在什么时刻需要访问」。")

    # ---------------- 09 最贵的 bug ----------------
    slide = blank(deck)
    eyebrow(slide, "INCIDENT   ·   THE  MOST  EXPENSIVE  BUG")
    title(slide, "用户看到「生成失败」，服务端却照跑照扣费")
    rule(slide, ML, 1.92, CW)

    quarters = [
        ("症状", "点「生成试穿效果」后约 20 秒弹出\n「试衣生成失败，请重试」，但后台任务\n几分钟后是成功状态。"),
        ("根因", "试衣接口是同步的：要等供应商出图\n（实测 40–70 秒）。我给客户端设了\n20 秒超时 → 客户端先放弃。"),
        ("修法", "同步生成型超时放到 180 秒（≥ 供应商\n上限 90 秒）；超时文案改成「还在后台\n生成，稍后到「我的」看结果」。"),
        ("教训", "超时策略要跟着接口形态走：\n同步生成给长超时，异步轮询给短超时。\n钱花在了用户看不见的地方。"),
    ]
    for index, (head, body) in enumerate(quarters):
        x = round(ML + index * 2.96, 3)
        txt(slide, x, 2.26, 2.6, 0.3, f"0{index + 1}  {head}", font=SANS, size=11, color=ACCENT, bold=True)
        txt(slide, x, 2.66, 2.66, 1.5, body, font=SANS, size=10.5, color=INK if index < 3 else MUTED, line=1.8)

    block(slide, ML, 4.42, CW, 1.34, fill=WASH)
    txt(slide, ML + 0.32, 4.6, CW - 0.6, 1.0,
        "同类问题在这个项目里出现了三次：视频轮询给了 10 分钟（供应商实测排到 25 分钟）、"
        "删除记录先删文件后删行（行删失败时文件已丢）、客户端重试没有幂等键（重复扣费）。\n"
        "共同点：都不是「功能没写完」，而是「失败路径没设计」。",
        font=SANS, size=11.5, color=INK, line=1.85)

    txt(slide, ML, 6.02, CW, 0.6,
        "所以我给自己定的规则是：每接一个外部服务，先写清楚它的失败形态（超时 / 限流 / 欠费 / 返回非 JSON），再写正常路径。",
        font=SANS, size=10.5, color=MUTED, line=1.6)
    page_no(slide, 9, total)
    notes(slide, "全栈岗必讲。结构固定为「症状 / 根因 / 修法 / 教训」，30 秒讲完，"
                 "最后落到方法论（先写失败形态），比说「我修了一个 bug」高一个层次。")

    # ---------------- 10 提示词工程 ----------------
    slide = blank(deck)
    eyebrow(slide, "PROMPT   ENGINEERING")
    title(slide, "让模型「转身」，而不是让衣服「穿反」")
    rule(slide, ML, 1.92, CW)

    formula = ["运动", "运镜", "背景", "保真约束", "收尾 guard"]
    for index, part in enumerate(formula):
        x = round(ML + index * 1.86, 3)
        block(slide, x, 2.26, 1.66, 0.56, fill=INK if index < 2 else PAPER,
              line_color=None if index < 2 else HAIR)
        txt(slide, x, 2.4, 1.66, 0.3, part, font=SANS, size=10.5,
            color=PAPER if index < 2 else INK, align=PP_ALIGN.CENTER)

    txt(slide, ML, 3.1, 6.9, 1.5,
        "图生视频的公开公式是「提示词 = 运动 + 运镜」：图片已经决定了主体与场景，\n"
        "所以提示词只需要描述「怎么动、镜头怎么动」。我把姿势库的每条描述都改写成了这两段，\n"
        "再补上「锁定背景」和「面部与服装逐帧一致」的硬约束。",
        font=SANS, size=11.5, color=MUTED, line=1.85)

    txt(slide, 7.62, 3.1, 4.9, 0.3, "为什么是「单向转身」", font=SANS, size=11, color=INK, bold=True)
    txt(slide, 7.62, 3.5, 4.9, 1.9,
        "常见做法是转过去再转回来，但两次大幅重绘会让脸最容易崩，而且要把时长从 5 秒拉到 10 秒（成本翻倍）。\n"
        "改成「正面微动 → 两步前移 → 一次连续转身 → 背对镜头定格」，最后 1/3 时间脸不在画面里，成本不变。",
        font=SANS, size=10.5, color=MUTED, line=1.8)

    rule(slide, ML, 5.42, CW)
    txt(slide, ML, 5.6, CW, 1.2,
        "副作用与二次收益：转身定格的那一帧，正好是衣服的背面 —— 于是「视频最后一帧存为背面素材」这个功能零成本成立。\n"
        "另一个坑：姿势描述里已含 Camera 句，会和通用运镜段打架（症状是原地摇晃），所以先用正则把姿势里的运镜句剥掉。",
        font=SANS, size=11, color=INK, line=1.8)
    page_no(slide, 10, total)
    notes(slide, "面试官对「AI 是你调的吗」通常有怀疑，这页就是答案："
                 "公式来源、成本约束下的设计取舍、以及一次真实的失败（转回来脸会崩）。")

    # ---------------- 11 量化 ----------------
    slide = blank(deck)
    eyebrow(slide, "MEASURED,  NOT  ESTIMATED")
    title(slide, "全部是实测数字")
    rule(slide, ML, 1.92, CW)

    headers = ["环节", "实测", "成本", "备注"]
    rows = [
        ["穿搭问答（qwen-plus）", "3.8s 首字", "¥0.001 / 次", "带风格档案 + 衣橱上下文"],
        ["单件试衣（Aidge 同步）", "40–70s", "¥0.4 / 张", "3 件串行 ≈ 3 分钟"],
        ["视频提交（万相 i2v）", "5.4s 拿任务号", "¥0.3–0.5 / 5 秒", "异步任务，需轮询"],
        ["视频出片", "70s–25min", "同上", "排队最久一次 25 分钟"],
        ["Web 首屏（冷启动）", "约 8s，热启动 1.2s", "—", "之后每条请求 1.2s 量级"],
        ["Android 包体", "91.5 MB", "—", "四 ABI 通用包，未拆分"],
    ]
    rows_table(slide, ML, 2.3, CW, headers, rows, col_ratios=[3.6, 3.0, 2.6, 4.4], row_h=0.56)

    txt(slide, ML, 6.28, CW, 0.6,
        "为什么强调实测：这些数字决定了产品策略 —— 超时阈值、限流次数、定价与免费额度，全部由它们反推。",
        font=SANS, size=11, color=MUTED, line=1.6)
    page_no(slide, 11, total)
    notes(slide, "数字要能解释来源：25 分钟那次排队直接导致我把服务端超时从 10 分钟改到 30 分钟，"
                 "并把客户端等待上限对齐。数字不是装饰，是决策依据。")

    # ---------------- 12 结尾 ----------------
    slide = blank(deck)
    eyebrow(slide, "WHAT  I  LEARNED   &   WHAT  IS  NEXT")
    title(slide, "三件我认为做对了的事")
    rule(slide, ML, 1.92, CW)

    learnings = [
        ("先定 token，再定组件，最后才是页面", "5 套主题只换一份配置；换肤不需要动任何页面代码。"),
        ("先把失败路径想清楚", "每接一个外部服务，先写清超时 / 限流 / 欠费 / 脏数据四种形态。"),
        ("把「看起来是 bug」的问题当产品问题查", "匿名身份 + 本地存储 = 清缓存即丢历史，这不是代码错，是设计缺口，所以补了恢复码。"),
    ]
    for index, (head, body) in enumerate(learnings):
        y = round(2.24 + index * 1.2, 3)
        txt(slide, ML, y, 0.4, 0.32, f"0{index + 1}", font=NUM, size=11, color=ACCENT)
        txt(slide, ML + 0.48, y - 0.04, 7.2, 0.36, head, font=SONG, size=17, color=INK)
        txt(slide, ML + 0.48, y + 0.42, 7.2, 0.6, body, font=SANS, size=10.5, color=MUTED, line=1.7)

    rule(slide, 8.6, 2.24, 0.012, color=HAIR, weight=0.9)
    txt(slide, 8.92, 2.24, 3.6, 0.3, "如果是我的下一步", font=SANS, size=10, color=MUTED, tracking=2)
    nexts = ["任务状态机（幂等 + CAS 结束态）", "多供应商抽象（方舟 / 可灵）",
             "整套试穿后端化（advance-on-request）", "姿态驱动视频（替代纯文本提示）"]
    for index, item in enumerate(nexts):
        txt(slide, 8.92, 2.66 + index * 0.52, 3.6, 0.4, f"·  {item}", font=SANS, size=10.5, color=INK, line=1.4)

    rule(slide, ML, 5.96, CW)
    txt(slide, ML, 6.14, CW, 0.7,
        "完整技术记录：迭代报告 27 节 / 后端路线图 10 项 —— 每一节都是「为什么做 + 怎么验证」，不是功能清单。",
        font=SANS, size=11.5, color=MUTED, line=1.6)
    txt(slide, SLIDE_W - MR - 3.0, 6.14, 3.0, 0.4, "谢谢", font=SONG, size=16, color=INK, align=PP_ALIGN.RIGHT)
    page_no(slide, 12, total)
    notes(slide, "收尾不要复述功能，讲「三条方法论 + 下一步」，"
                 "把话题引到「你怎么思考」而不是「你做了什么」。")

    deck.save(OUT)
    print(f"saved {OUT} ({OUT.stat().st_size} bytes, {len(deck.slides.__iter__.__self__._sldIdLst)} slides)")


if __name__ == "__main__":
    build()
