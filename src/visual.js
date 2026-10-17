/*!
 * 盲棋象棋 · 视觉几何与动效参数（v1.5 §11.5）
 * 与渲染解耦的纯函数，便于验收测试量取 T-61 / T-63 ~ T-66。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BXVisual = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const TIMINGS = {
    move: 320,       // 抬起 80 + 平移 180 + 落地 60
    lift: 80,
    translate: 180,
    land: 60,
    flip: 320,       // 5a/5b/5c/5d
    capture: 200,
    card: 900,
    reducedFlip: 120,
  };

  const PIECE = {
    diameterRatio: 0.86,
    thicknessRatio: 0.10,
    minScale: 0.10,       // H / D
    rimThreshold: 0.35,
    shadowOffsetRatio: 0.18, // × H
    shadowBlurRatio: 0.12,   // × D
    shadowAlpha: 0.22,
    highlightSweepDeg: 15,
  };

  /** 翻面两连音参数（§11.5.2）：总长 ≤220ms，音量低于落子 */
  const AUDIO = {
    flipClicks: [0, 90],
    flipDurations: [70, 120],
    flipTotal: 210,
    maxTotal: 220,
    gainBelowMoveDb: 3,
  };

  const clamp01 = (t) => Math.max(0, Math.min(1, t));
  const easeInCubic = (t) => t * t * t;
  const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);
  const easeInOutCubic = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

  /** overshoot 约 1.06 的 ease-out-back */
  function easeOutBack(t) {
    const c1 = 1.4;
    const c3 = c1 + 1;
    return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
  }

  function geometry(cell) {
    const D = cell * PIECE.diameterRatio;
    const H = D * PIECE.thicknessRatio;
    return {
      cell,
      D,
      H,
      R: D / 2,
      shape: 'circle',
      shadowOffsetY: H * PIECE.shadowOffsetRatio,
      shadowBlur: D * PIECE.shadowBlurRatio,
      shadowAlpha: PIECE.shadowAlpha,
    };
  }

  /**
   * 走子阶段（0..320ms）：抬起 80 / 平移 180 / 落地 60
   * @returns {{progress:number, travel:number, lift:number, liftAmount:number, shadowScale:number, shadowAlpha:number, phase:string}}
   */
  function moveTransform(elapsed) {
    const t = Math.max(0, elapsed);
    if (t < TIMINGS.lift) {
      const u = t / TIMINGS.lift;
      const amount = easeOutCubic(u);
      return {
        progress: t / TIMINGS.move,
        travel: 0,
        lift: -6 * amount,
        liftAmount: amount,
        shadowScale: 1 + 0.15 * amount,
        shadowAlpha: 0.22 + 0.08 * amount,
        phase: 'lift',
      };
    }
    if (t < TIMINGS.lift + TIMINGS.translate) {
      const u = (t - TIMINGS.lift) / TIMINGS.translate;
      return {
        progress: t / TIMINGS.move,
        travel: easeInOutCubic(u),
        lift: -6,
        liftAmount: 1,
        shadowScale: 1.15,
        shadowAlpha: 0.30,
        phase: 'translate',
      };
    }
    if (t < TIMINGS.move) {
      const u = (t - TIMINGS.lift - TIMINGS.translate) / TIMINGS.land;
      const amount = 1 - easeInCubic(u);
      return {
        progress: t / TIMINGS.move,
        travel: 1,
        lift: -6 * amount,
        liftAmount: amount,
        shadowScale: 1 + 0.15 * amount,
        shadowAlpha: 0.22 + 0.08 * amount,
        phase: 'land',
      };
    }
    return {
      progress: 1,
      travel: 1,
      lift: 0,
      liftAmount: 0,
      shadowScale: 1,
      shadowAlpha: 0.22,
      phase: 'done',
    };
  }

  /**
   * 翻面四段（0..320ms）
   * 5a 0–90 立起；5b 90 换面；5c 90–240 倒下（overshoot 1.06）；
   * 5d 240–320 高光扫过。
   */
  function flipTransform(elapsed, cell, opts) {
    const options = opts || {};
    if (options.reduced) {
      const p = clamp01(elapsed / TIMINGS.reducedFlip);
      return {
        duration: TIMINGS.reducedFlip,
        progress: p,
        scaleY: 1,
        lift: 0,
        shine: 0,
        rim: false,
        crossfade: true,
        minScale: 1,
      };
    }
    const t = clamp01(elapsed / TIMINGS.flip);
    const T1 = 90 / TIMINGS.flip;
    const T2 = 240 / TIMINGS.flip;
    const MIN = PIECE.minScale;
    let scaleY;
    let lift;
    if (t < T1) {
      const u = easeInCubic(t / T1);
      scaleY = 1 - (1 - MIN) * u;
      lift = -0.03 * (cell * PIECE.diameterRatio) * u;
    } else if (t < T2) {
      const u = easeOutBack((t - T1) / (T2 - T1));
      scaleY = MIN + (1 - MIN) * u;
      lift = -0.03 * (cell * PIECE.diameterRatio) * (1 - u);
    } else {
      scaleY = 1;
      lift = 0;
    }
    const shineU = t <= T2 ? 0 : (t - T2) / (1 - T2);
    const shine = shineU > 0 ? 0.35 * Math.sin(Math.PI * shineU) : 0;
    return {
      duration: TIMINGS.flip,
      progress: t,
      scaleY,
      lift,
      shine,
      rim: scaleY < PIECE.rimThreshold,
      crossfade: false,
      minScale: MIN,
    };
  }

  function prefersReducedMotion() {
    try {
      return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    } catch (err) {
      return false;
    }
  }

  return {
    TIMINGS,
    PIECE,
    AUDIO,
    clamp01,
    easeInCubic,
    easeOutCubic,
    easeInOutCubic,
    easeOutBack,
    geometry,
    moveTransform,
    flipTransform,
    prefersReducedMotion,
  };
});
