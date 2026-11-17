# -*- coding: utf-8 -*-
"""生成 A4 单页《项目技术纸》——简历附件用。

一页打完：一句话 / 关键数字 / 四层架构 / 三个踩过的坑 / 量化数据 / 工程规模。
与面试 PPT、App 的 runway 主题同一套视觉语言。

版面用「游标累加」而非写死坐标，改文字不会互相压。
"""
from pathlib import Path

from pptx import Presentation
from pptx.dml.color import RGBColor
from pptx.enum.shapes import MSO_SHAPE
from pptx.enum.text import MSO_ANCHOR, PP_ALIGN
from pptx.util import Emu, Inches, Pt

OUT = Path(__file__).with_name("02-一页技术纸.pptx")

INK = RGBColor(0x11, 0x11, 0x13)
MUTED = RGBColor(0x6B, 0x6B, 0x70)
FAINT = RGBColor(0x9A, 0x9A, 0x9F)
HAIR = RGBColor(0xE9, 0xE9, 0xEC)
WASH = RGBColor(0xF6, 0xF6, 0xF7)
ACCENT = RGBColor(0xB4, 0x86, 0x5E)

SONG = "SimSun"
SANS = "Microsoft YaHei"
NUM = "Georgia"

A4_W, A4_H = 8.27, 11.69
ML = 0.62
CW = round(A4_W - ML * 2, 3)   # 7.03


def _tracking(run, points):
    run.font._rPr.set("spc", str(int(points * 100)))


def txt(slide, x, y, w, h, text, *, font=SANS, size=9, color=INK, bold=False,
        align=PP_ALIGN.LEFT, line=1.4, tracking=None, anchor=MSO_ANCHOR.TOP):
    box = slide.shapes.add_textbox(Inches(x), Inches(y), Inches(w), Inches(h))
    frame = box.text_frame
    frame.word_wrap = True
    frame.margin_left = 0
    frame.margin_right = 0
    frame.margin_top = 0
    frame.margin_bottom = 0
    frame.vertical_anchor = anchor
    for index, line_text in enumerate(text.split("\n")):
        para = frame.paragraphs[0] if index == 0 else frame.add_paragraph()
        para.alignment = align
        para.line_spacing = line
        para.space_before = Pt(0)
        para.space_after = Pt(0)
        run = para.add_run()
        run.text = line_text
        run.font.name = font
        run.font.size = Pt(size)
        run.font.bold = bold
        run.font.color.rgb = color
        if tracking:
            _tracking(run, tracking)
    return box


def rule(slide, x, y, w, *, color=HAIR, weight=0.75):
    line = slide.shapes.add_shape(MSO_SHAPE.RECTANGLE, Inches(x), Inches(y),
                                  Inches(w), Emu(int(weight * 12700)))
    line.fill.solid()
    line.fill.fore_color.rgb = color
    line.line.fill.background()
    line.shadow.inherit = False
    return line


def section(slide, y, label, title_text):
    """小标题行：左侧宽字距英文标签 + 右侧宋体标题 + 细线。返回内容起始 y。"""
    txt(slide, ML, y + 0.02, 1.5, 0.2, label, font=SANS, size=6.8, color=FAINT, tracking=1.7)
    txt(slide, ML + 1.52, y - 0.05, CW - 1.52, 0.3, title_text, font=SONG, size=12, color=INK)
    rule(slide, ML, y + 0.28, CW)
    return round(y + 0.4, 3)


def build():
    deck = Presentation()
    deck.slide_width = Inches(A4_W)
    deck.slide_height = Inches(A4_H)
    slide = deck.slides.add_slide(deck.slide_layouts[6])

    # ---------------- 页眉 ----------------
    txt(slide, ML, 0.5, CW, 0.2,
        "PROJECT  NOTE   ·   AI  FASHION  TRY-ON   ·   2026",
        font=SANS, size=7, color=MUTED, tracking=2.0)
    txt(slide, ML, 0.74, CW, 0.56, "AI 穿搭管家", font=SONG, size=29, color=INK, bold=True, line=1.05)
    txt(slide, ML, 1.36, CW, 0.26,
        "一张全身照 + 一件单品，把「看到喜欢的衣服」变成「看到自己穿上、并且动起来」。",
        font=SANS, size=9.6, color=MUTED, line=1.4)
    rule(slide, ML, 1.7, CW, color=INK, weight=1.2)

    # ---------------- 关键数字 ----------------
    numbers = [
        ("3.8s", "问答首字"),
        ("40–70s", "单件试衣"),
        ("¥0.4", "单张成本"),
        ("8.0k", "行 TS / TSX"),
        ("22", "数据库迁移"),
    ]
    for index, (number, label) in enumerate(numbers):
        x = round(ML + index * 1.41, 3)
        txt(slide, x, 1.84, 1.36, 0.32, number, font=NUM, size=18, color=INK, line=1.0)
        txt(slide, x, 2.2, 1.36, 0.2, label, font=SANS, size=7.2, color=MUTED)

    # ---------------- 架构 ----------------
    y = section(slide, 2.56, "ARCHITECTURE", "一条链路，四层边界")
    layers = [
        ("客户端", "Expo RN（iOS / Android / Web 同一套代码）", "5 套主题 token 化 · 分页灵感动线 · 签名 URL 缓存"),
        ("边缘函数", "Supabase Edge Functions · Deno", "tryon / video / chat / garment-back / payment"),
        ("AI 供应商", "Aidge 试衣 · 通义万相 i2v · qwen-plus", "同步出图 / 异步任务轮询 / OpenAI 兼容对话"),
        ("数据与存储", "Postgres + Storage（私有桶）", "RLS 按 owner 收口 · 恢复码走 definer 函数"),
    ]
    for index, (name, stack, detail) in enumerate(layers):
        row_y = round(y + index * 0.46, 3)
        txt(slide, ML, row_y, 0.86, 0.22, name, font=SONG, size=10, color=INK)
        txt(slide, ML + 0.9, row_y + 0.02, 2.55, 0.22, stack, font=SANS, size=7.8, color=INK)
        txt(slide, ML + 3.5, row_y + 0.02, 3.5, 0.22, detail, font=SANS, size=7.8, color=MUTED, line=1.3)
        if index < len(layers) - 1:
            rule(slide, ML, row_y + 0.36, CW)
    y = round(y + len(layers) * 0.46 + 0.04, 3)
    txt(slide, ML, y, CW, 0.2,
        "边界原则：密钥只在边缘函数；前端只有 anon key；存储一律私有 + 现签地址；每次外部调用都必须有超时与降级。",
        font=SANS, size=7.4, color=MUTED)

    # ---------------- 三个坑 ----------------
    y = section(slide, 5.28, "ENGINEERING  NOTES", "三个真实踩过的坑")
    pits = [
        ("同步接口给了短超时",
         "试衣要等供应商 40–70 秒，客户端却设了 20 秒超时：用户看到「生成失败」，服务端照跑照扣费。",
         "同步生成超时放到 180 秒（≥ 供应商上限），文案改为「还在后台生成，稍后到「我的」看结果」。"),
        ("RLS「任一策略通过即放行」",
         "两个匿名账号对照实验：B 能往 A 的目录上传、能删 A 的文件，未登录能列举照片桶。旧宽策略没清理，新策略形同虚设。",
         "按表扫描删掉所有涉及这些桶的旧策略，再按 owner 重建；写入收归 service_role。修复后同一批探针全部 403。"),
        ("桶私有化打断了供应商链路",
         "试衣与图生视频只能拿 URL 去下载图片，桶一私有全部 400。",
         "库里存规范地址（不含 token），只在看图和调供应商那一次签 1 小时地址，带缓存与并发去重。"),
    ]
    for index, (head, symptom, fix) in enumerate(pits):
        row_y = round(y + index * 0.94, 3)
        txt(slide, ML, row_y, 0.28, 0.22, f"0{index + 1}", font=NUM, size=8.2, color=ACCENT)
        txt(slide, ML + 0.32, row_y - 0.01, 2.0, 0.22, head, font=SANS, size=8.6, color=INK, bold=True, line=1.3)
        txt(slide, ML + 2.42, row_y - 0.02, 4.6, 0.34, symptom, font=SANS, size=7.4, color=MUTED, line=1.45)
        txt(slide, ML + 2.42, row_y + 0.36, 4.6, 0.34, fix, font=SANS, size=7.4, color=INK, line=1.45)
        if index < len(pits) - 1:
            rule(slide, ML, row_y + 0.84, CW)

    # ---------------- 量化 ----------------
    y = section(slide, 8.3, "MEASURED", "全部是实测数字，不是估算")
    headers = ["环节", "实测", "成本", "备注"]
    col_x = [ML, ML + 2.3, ML + 3.85, ML + 4.85]
    widths = [2.25, 1.5, 0.95, 2.1]
    rows = [
        ["穿搭问答（qwen-plus）", "3.8s 首字", "¥0.001", "带风格档案 + 衣橱上下文"],
        ["单件试衣（Aidge 同步）", "40–70s", "¥0.4", "3 件串行 ≈ 3 分钟、¥1.2"],
        ["视频提交（万相 i2v）", "5.4s", "¥0.3–0.5", "异步任务，需轮询"],
        ["视频出片", "70s–25min", "同上", "排队最久一次 25 分钟"],
    ]
    for index, header in enumerate(headers):
        txt(slide, col_x[index], y, widths[index], 0.18, header, font=SANS, size=6.8, color=FAINT, tracking=1.3)
    rule(slide, ML, y + 0.19, CW)
    for row_index, row in enumerate(rows):
        row_y = round(y + 0.26 + row_index * 0.24, 3)
        for col_index, cell in enumerate(row):
            txt(slide, col_x[col_index], row_y, widths[col_index], 0.2, cell,
                font=SANS, size=7.8, color=INK if col_index == 0 else MUTED, line=1.25)
        rule(slide, ML, row_y + 0.19, CW)

    # ---------------- 工程规模 ----------------
    y = section(slide, 9.94, "SCALE", "工程规模与可维护性")
    scale_items = [
        ("38 文件 / 8.0k 行", "客户端 TS（9 个路由页）"),
        ("5 函数 / 1.9k 行", "全部带超时与限流"),
        ("22 迁移 / 1.2k 行", "RLS 与存储策略可重跑"),
        ("27 节迭代报告", "为什么做 + 怎么验证"),
    ]
    for index, (head, detail) in enumerate(scale_items):
        x = round(ML + index * 1.78, 3)
        txt(slide, x, y, 1.72, 0.2, head, font=SANS, size=8.2, color=INK, bold=True, line=1.3)
        txt(slide, x, y + 0.22, 1.72, 0.3, detail, font=SANS, size=7.2, color=MUTED, line=1.35)

    # ---------------- 页脚 ----------------
    rule(slide, ML, 11.12, CW, color=INK, weight=1.0)
    txt(slide, ML, 11.2, CW, 0.3,
        "仓库：github.com/<your-handle>/ai-outfit-butler　·　演示与截图见 docs/迭代报告-2026-11-16.md　·　面试讲解版另有 12 页 PPT",
        font=SANS, size=6.8, color=FAINT, line=1.4)

    deck.save(OUT)
    print(f"saved {OUT} ({OUT.stat().st_size} bytes)")


if __name__ == "__main__":
    build()
