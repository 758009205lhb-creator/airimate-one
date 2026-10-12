# A16 · 空闲帧率与内存（通过）

| 字段 | 值 |
|---|---|
| 判据 | **A16**：空闲平均帧率 ≥ 50fps（`fps.avg5s ≥ 50`）；无持续内存增长 |
| 命令 | ① `--fps-cap 120` 判定瓶颈；② 默认配置下每 6s 采样 `fps`/`heapMB`，8 个样本 |
| 结果 | **PASS** |

## 判定帧率瓶颈（关键一步）

| 配置 | 实测 `fps1s` | 结论 |
|---|---|---|
| 泵 16ms + `fpsCap=60` | 47–50（avg **48.1**） | 未达标 |
| 泵 8ms + `fpsCap=60` | 48–50（avg **49.4**） | 仍差 0.6 |
| 泵 8ms + **`fpsCap=120`** | **82–83** | **渲染成本充足** ⇒ 瓶颈是"60 上限 + 泵与 vsync 错位导致的整帧跳过" |

⇒ 修法：**默认 `fpsCap` 由 60 提到 90**（用户仍可在设置里改 15–240）。

## 最终实测（默认配置：泵 8ms + `fpsCap=90`）

```
n=3  fps1s=64 fps5s=53.7 heap=131.6MB base=idle_pet_idle
n=4  fps1s=65 fps5s=63.4 heap=159.1MB base=idle_pet_idle_10
n=7  fps1s=64 fps5s=64.4 heap=121.4MB base=idle_pet_idle_2
n=8  fps1s=66 fps5s=63.7 heap=136.9MB base=idle_pet_idle_3

汇总：fps1s avg=64.5（64–66）   fps5s min=53.7   heap 121.4–159.1 MB
```

| 检查 | 要求 | 实测 | 结论 |
|---|---|---|---|
| 空闲帧率（`fps5s`） | ≥ 50 | **min 53.7 / 典型 63.7** | ✅ |
| 空闲帧率（`fps1s`） | — | 64–66 | ✅ |
| 无持续内存增长 | 不单调上升 | 121.4–159.1 MB 在**同一区间反复** | ✅ |
| 待机轮换 | 12s 一次 | 采样期间正常切换（`idle_pet_idle` → `_10` → `_2` → `_3`） | ✅ |

**证据**：`docs/evidence/phase8/A16-perf-final.jsonl`（逐样本 JSONL）、`A16-perf.md`（本文）。

## 说明

- 判据只要求"空闲 ≥50fps"，本机在 panel 模式下典型 64fps，有 ~28% 余量；
- `heapMB` 是该 renderer 的 JS 堆（`performance.memory.usedJSHeapSize`），
  在 120–160 MB 之间反复波动、**无上升趋势** ⇒ 未见泄漏；
- 2 小时浸泡（判据 **A15**）仍未做 —— 上面只是 ~60 秒的短时采样，**不能替代浸泡**。
