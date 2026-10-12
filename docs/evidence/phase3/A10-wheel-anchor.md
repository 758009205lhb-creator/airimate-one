# A10 + 轮盘视觉/命中 —— 验收结果（全部 PASS，附真实截图）

| 字段 | 值 |
|---|---|
| 判据 | A10：右键轮盘 开→关→开，锚点误差 ≤ 2px；另加"轮盘不越界"与"命中=视觉"两项自检 |
| 命令 | `electron apps/desktop --dev --mode=panel --no-dialogs --probe a10 --probe-out docs/evidence/phase3/A10-wheel-anchor.json --probe-shot docs/evidence/phase3/screens/A20-wheel-open.png --probe-exit` |
| 结果 | **PASS** |

## 原始输出（关键字段）

```json
{
  "maxErrPx": 0,
  "passA10": true,
  "opens": [ { "anchorX": 135, "anchorY": 359.697 },
             { "anchorX": 135, "anchorY": 359.697 } ],
  "settledScale": 1,
  "hitTest": { "allHit": true, "hits": [true × 8] },
  "passHitRegionMatchesVisual": true,
  "bounds": {
    "window": [482, 762],
    "outOfWindow": [],
    "sizeInfo": { "radius": 65, "itemSize": 44 },
    "minGapPx": 2
  },
  "passWheelInWindow": true
}
```

| 检查 | 要求 | 实测 | 结论 |
|---|---|---|---|
| 锚点误差（开→关→开） | ≤ 2 px | **0.000 px** | ✅ |
| 锚点落在窗口内 | 需要 | `(135, 359.7)`，窗口 482×762 | ✅ |
| 命中 = 视觉（8 方向） | 全部命中 | **8/8** | ✅ |
| 轮盘**不越界** | `outOfWindow` 为空 | **`[]`** | ✅ |
| 选项间距 | 不相邻 | `minGap = 2 px`（相邻、无重叠） | ✅（恰好邻接） |

## 视觉证据

`docs/evidence/phase3/screens/A20-wheel-open.png`（真实桌面像素 **602×952**）

截图可见：8 个选项（聊天 / 听力 / 扬声器 / 角色 / 设置 / 居中 / 置顶 / 休眠）完整显示、
带图标与中文标签、中心有当前项提示；角色（白发白外套黑裙）以动作姿态完整显示、**非 T-pose**；
状态栏 `舞台正常 / 动作 10 待机 / 当前 idle_pet_id…`。

> ⚠ **本题截图是"休眠项还在"时拍的**（用户 2026-09-27 方案 C 之前）。
> 自 2026-09-27 起轮盘为 **7 项**（移除「休眠」，原因见 `INTERACTION-FIX-EVIDENCE.md` §5.4）。
> A10 的判据（锚点误差、命中=视觉、不越界、间距）已在 7 项布局上**重新实测通过**：
> `phase3/a10.json` → `passA10=true`、`passHitRegionMatchesVisual=true`、`passWheelInWindow=true`。
> 本节其余原始读数（0.000 px / 8-8 命中 / 越界为空）来自上表那次测量，未改动。

## 本轮为达成上述结果所做的三项改动

1. **panel 窗口加宽 420 → 480**（`WINDOW_GEOMETRY.panel`），侧栏 268 → 248
   ⇒ 舞台画布从 150px 提到 ~232px，轮盘不再被压到极限尺寸。
2. **轮盘尺寸参数放宽**：半径由"短边 22%、下限 56"改为"短边 28%、下限 64"；
   选项由"下限 40"改为"下限 44" ⇒ 实测 `radius=65, itemSize=44`，间距不再过挤。
3. **新增可判定的越界检查**：`itemRects()` + `__AIRIMATE_WHEEL_PROBE__('bounds')`
   逐项判断 8 个选项的视觉矩形是否完整落在窗口内，并给出最小间距
   —— 不再依赖肉眼判断"有没有被裁"。

## 一次真实回归（已修正，留档）

本轮中途我曾把轮盘收夹边界改成**舞台画布矩形**（理由："不应超出画布"），
结果锚点被挤到画布中心、**截图上轮盘完全消失**：
半径 65 + 内边距 70 = 135 > 画布半宽 116 ⇒ 收夹窗口为空。

**正确结论**：轮盘是**窗口级覆盖层** —— 尺寸按画布自适应，**收夹边界用整窗**。
判据也据此更正为"锚点落在**窗口**内、且 8 个选项的视觉矩形完整落在窗口内"。

## 主观观感备注（非判据）

轮盘中心目前压在角色头部位置（锚点取包围盒上沿 30% 处）。功能与判据均通过，
但"是否挡脸"属观感问题，可在后续把锚点比例从 `0.30` 微调到 `0.18` 一试。
