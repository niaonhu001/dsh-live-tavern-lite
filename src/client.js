/**
 * dsh-live-tavern — browser half.
 *
 * Mounts one PixiJS application into one placement seat (chat column
 * background, frame overlay, or sidebar) and mirrors that single WebGL canvas
 * into the remaining seats, so a 190 MB texture set is uploaded once.
 *
 * Every DOM write is owned by `apply()` and undone by its disposer: seats,
 * attribute marks, styles, observers, the render loop and the calibration panel.
 */

import { evaluateChecks, readPoseSkeleton } from './pose-checks.js'
import React from 'react'
import { Application, Rectangle, extensions } from 'pixi.js'
import { Live2DModel, Live2DPlugin, configureCubismSDK } from 'untitled-pixi-live2d-engine/cubism'
import { parseTracks, startTracks, stepTracks } from '../lib/tracks.mjs'
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm'

/** The settings page is a slot; without it the stage still runs. */
export const inject = ['slots']

const API = '/dsh-live-tavern-lite'

/**
 * Built-in settings values, so the per-field reset buttons work even against a
 * Host build that predates `/settings` returning `defaults`. The Host's copy is
 * authoritative whenever it arrives; an empty path means "use the default one".
 */
const FALLBACK_DEFAULTS = {
  placement: 'chat',
  model: '',
  pack: '',
  playerName: '玩家',
  textureLod: 'full',
  opacity: 1,
  lookAtPointer: false,
  hitBoxScale: 1,
  springStrength: 1,
  vrmStage: 'auto',
  mobileUi: 'auto',
  springGravity: 0,
  widthCap: 0.6,
  memoryScope: 'session',
  sessionMaxFacts: 24,
  recallScope: 'session',
  director: true,
  directorProvider: '',
  directorModel: '',
  directorEffort: '',
  stageEveryTurns: 1,
  stageUpdatesPerTurn: 2,
  interaction: false,
  directorMaxCallsPerHour: 60,
  directorMaxFacts: 24,
  directorMaxTokens: 4096,
  worldbookBudgetTokens: 8192,
  rigMaxTokens: 4096,
  worldbookScanDepth: 8,
  worldbookCooldownRounds: 2,
}
const PANEL_TITLE = 'Live2D 标定'
const STYLE_ID = 'dsh-live-tavern-style'
const SEATS = ['chat', 'foreground', 'sidebar']
const SEAT_LABELS = { chat: '聊天区底', foreground: '前景', sidebar: '侧栏' }
const EMOTIONS = ['neutral', 'joy', 'sad', 'anger', 'surprise', 'fear', 'shy', 'tender']

const CSS = `
[data-dsh-l2d-anchor]{position:relative}
.dsh-l2d-seat{position:fixed;inset:0;overflow:hidden;pointer-events:none}
.dsh-l2d-seat[data-placement="foreground"]{position:fixed;inset:0;z-index:2147482000}
.dsh-l2d-seat[data-placement="chat"]{z-index:-1}
.dsh-l2d-seat[data-placement="sidebar"]{z-index:-1}
.dsh-l2d-host{position:absolute;inset:0}
.dsh-l2d-host canvas{display:block;width:100%;height:100%}
.dsh-l2d-mirror{position:absolute;inset:0;width:100%;height:100%}
.dsh-l2d-mask{position:absolute;left:50%;bottom:24px;transform:translateX(-50%);font:12px/1.6 ui-sans-serif,system-ui;color:#8a7d70;background:rgba(255,255,255,.72);border:1px solid rgba(78,50,23,.12);border-radius:999px;padding:5px 14px;white-space:nowrap}
.dsh-l2d-bubble{position:fixed;left:50%;bottom:46%;transform:translateX(-50%);z-index:2147482900;max-width:min(360px,74%);background:rgba(255,255,255,.93);border:1px solid rgba(78,50,23,.14);border-radius:12px;padding:8px 12px;font:13px/1.65 ui-sans-serif,system-ui;color:#2b241d;box-shadow:0 6px 20px rgba(78,50,23,.12);opacity:0;transition:opacity .18s ease;pointer-events:none}
.dsh-l2d-bubble[data-show="1"]{opacity:1}
.dsh-l2d-bubble:after{content:'';position:absolute;left:50%;bottom:-6px;width:10px;height:10px;background:rgba(255,255,255,.93);border-right:1px solid rgba(78,50,23,.14);border-bottom:1px solid rgba(78,50,23,.14);transform:translateX(-50%) rotate(45deg)}
.dsh-l2d-error{position:fixed;left:16px;bottom:16px;z-index:2147483000;max-width:520px;font:12px/1.6 ui-monospace,monospace;color:#7a1d1d;background:#fff3f1;border:1px solid #e2b4ab;border-radius:10px;padding:10px 12px;white-space:pre-wrap;pointer-events:auto}
.dsh-l2d-set{font:13px/1.7 ui-sans-serif,system-ui;color:#2b241d;max-width:720px}
.dsh-l2d-set *,.dsh-l2d-set *:before,.dsh-l2d-set *:after{box-sizing:border-box}
.dsh-l2d-set .grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:0 26px;margin:10px 0 16px;border-top:1px solid rgba(78,50,23,.1)}
@media (max-width:760px){.dsh-l2d-set .grid{grid-template-columns:1fr}}
.dsh-l2d-set .field{display:grid;grid-template-columns:96px minmax(0,1fr) 26px;gap:3px 9px;align-items:center;padding:7px 0;border-bottom:1px solid rgba(78,50,23,.07);min-width:0}
.dsh-l2d-set .field>*{min-width:0}
.dsh-l2d-set .field>label{font-size:11.5px;color:#4e4e4e;letter-spacing:.02em;text-align:right;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;line-height:1.35}
.dsh-l2d-set button.reset{padding:3px 0;line-height:1.2;font-size:12px;border-radius:6px;color:#8a8175;width:26px}
.dsh-l2d-set .status[data-state=ok]{color:#4f6b4a}
.dsh-l2d-set .status[data-state=error]{color:#8a3b2b}
.dsh-l2d-set .status[data-state=busy]{color:#8a5a2b}
.dsh-l2d-set .field>label[data-hint]{cursor:help}
.dsh-l2d-set .field.wide{grid-column:1 / -1}
.dsh-l2d-set .field.wide{grid-template-columns:96px minmax(0,1fr) 26px}
.dsh-l2d-set .field .pad{display:block;grid-column:3;grid-row:1}
.dsh-l2d-set .field.picker{grid-template-columns:96px minmax(0,1fr) 26px}
.dsh-l2d-set button.trigger{display:flex;align-items:center;gap:8px;justify-content:space-between;width:100%;min-width:0;padding:6px 9px;font-size:12px;background:#fff}
.dsh-l2d-set button.trigger .value{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-l2d-set button.trigger .chevron{color:#8a8175;font-size:11px}
.dsh-l2d-menu{position:fixed;z-index:2147483000;width:300px;max-height:340px;display:grid;grid-template-rows:auto 1fr;gap:6px;padding:8px;box-sizing:border-box;background:#fff;border:1px solid rgba(78,50,23,.18);border-radius:10px;box-shadow:0 12px 30px rgba(60,40,20,.16);font:13px/1.6 ui-sans-serif,system-ui;color:#2b241d}
.dsh-l2d-menu input{font:12px/1.4 ui-sans-serif,system-ui;padding:5px 8px;width:100%;box-sizing:border-box;border:1px solid rgba(78,50,23,.16);border-radius:7px;background:#fff;color:#2b241d}
.dsh-l2d-menu .list{overflow:auto;display:grid;gap:1px}
.dsh-l2d-menu .group{font:11px/1.4 ui-sans-serif,system-ui;color:#a3968a;letter-spacing:.06em;padding:6px 6px 2px}
.dsh-l2d-menu .item{display:flex;align-items:center;gap:8px;padding:5px 7px;font:12px/1.5 ui-sans-serif,system-ui;color:#2b241d;background:transparent;border:0;border-radius:7px;text-align:left;cursor:pointer}
.dsh-l2d-menu .item:hover{background:#f5f2ef}
.dsh-l2d-menu .item[data-active="1"]{background:#f0ebe5}
.dsh-l2d-menu .item[data-highlight="1"]{outline:1px solid #c9bcae;outline-offset:-1px}
.dsh-l2d-menu .item .item-hint{margin-left:auto;color:#a3968a;font-size:10.5px}
.dsh-l2d-menu .empty{font:11px/1.5 ui-sans-serif,system-ui;color:#c3b8ab;padding:2px 7px 6px}
.dsh-l2d-set .wb{margin-top:6px;display:grid;gap:2px}
.dsh-l2d-set .wb .wbsum{font-size:12px;color:#2b241d;padding:5px 0;border-bottom:1px solid rgba(78,50,23,.1)}
.dsh-l2d-set .wb .wbin{font-family:ui-monospace,monospace;font-size:11px;color:#4f6b4a;padding:2px 0}
.dsh-l2d-set .wb .wbdrop{font-family:ui-monospace,monospace;font-size:11px;color:#a3968a;padding:2px 0}
.dsh-l2d-set .wb .wbnone{font-size:12px;color:#a3968a;padding:4px 0}
.dsh-l2d-set .pickrow{display:grid;grid-template-columns:1fr auto;gap:6px;align-items:center;min-width:0}
.dsh-l2d-set button.pick{padding:6px 10px;font-size:11.5px;white-space:nowrap}
.dsh-l2d-set button.pick:disabled{opacity:.6;cursor:default}
.dsh-l2d-set input[type=text],.dsh-l2d-set input[type=number],.dsh-l2d-set select{font:12px/1.4 ui-sans-serif,system-ui;padding:6px 8px;border-radius:8px;border:1px solid rgba(78,50,23,.18);background:#fff;color:#2b241d;width:100%;min-width:0}
.dsh-l2d-set .switch{position:relative;display:inline-block;width:40px;height:22px;cursor:pointer;justify-self:start}
.dsh-l2d-set .switch input{position:absolute;inset:0;margin:0;width:100%;height:100%;opacity:0;cursor:pointer;z-index:1}
.dsh-l2d-set .switch .track{position:absolute;inset:0;border-radius:11px;background:#ded6cc;transition:background .18s ease}
.dsh-l2d-set .switch .track:after{content:'';position:absolute;left:2px;top:2px;width:18px;height:18px;border-radius:50%;background:#fff;box-shadow:0 1px 2px rgba(60,40,20,.22);transition:transform .18s ease}
.dsh-l2d-set .switch input:checked+.track{background:#8a5a2b}
.dsh-l2d-set .switch input:checked+.track:after{transform:translateX(18px)}
.dsh-l2d-set .switch input:focus-visible+.track{box-shadow:0 0 0 2px rgba(138,90,43,.28)}
.dsh-l2d-set .actions{display:flex;gap:8px;align-items:center}
.dsh-l2d-set button{font:12px/1 ui-sans-serif,system-ui;padding:7px 12px;border-radius:8px;border:1px solid rgba(78,50,23,.18);background:#faf7f4;color:#2b241d;cursor:pointer}
.dsh-l2d-set button:hover{background:#f0e9e2}
.dsh-l2d-set button.primary{background:#2b241d;border-color:#2b241d;color:#fff}
.dsh-l2d-set .status{font-size:12px;color:#4f6b4a}
.dsh-l2d-set .block{margin-top:24px;padding-top:18px;border-top:1px solid rgba(78,50,23,.12)}
.dsh-l2d-set .block h3{font:600 14px/1.4 ui-sans-serif,system-ui;margin:0 0 10px;color:#2b241d;letter-spacing:.02em}
.dsh-l2d-set .preset{display:grid;grid-template-columns:96px 104px minmax(0,1fr) 64px 64px 24px;gap:6px;align-items:center;margin-bottom:6px}
.dsh-l2d-set .preset input,.dsh-l2d-set .preset select{width:100%;box-sizing:border-box;padding:4px 6px;border:1px solid rgba(78,50,23,.18);border-radius:6px;background:#fff;font:12px/1.4 ui-sans-serif,system-ui;color:#2b241d}
.dsh-l2d-set .preset button.reset{justify-self:center}
.dsh-l2d-set .expr{padding:10px 0;border-top:1px solid rgba(78,50,23,.08)}
.dsh-l2d-set .expr-head{display:flex;gap:10px;align-items:center}
.dsh-l2d-set .expr-name{font-size:12px;color:#2b241d;min-width:72px;letter-spacing:.02em}
.dsh-l2d-set .expr-head select{width:auto;min-width:112px}
.dsh-l2d-set .expr-bars{display:grid;grid-template-columns:auto 1fr auto 1fr;gap:8px;align-items:center;margin-top:6px}
.dsh-l2d-set .expr-bars input[type=range]{width:100%}
.dsh-l2d-wb{position:fixed;inset:0;z-index:2147482600;display:grid;grid-template-rows:46px 1fr;background:#fffdfb;font:13px/1.6 ui-sans-serif,system-ui;color:#14100c}
.dsh-l2d-wb .wb-bar{display:flex;align-items:center;gap:12px;padding:0 16px;border-bottom:1px solid #e8e2db}
.dsh-l2d-wb .wb-title{font:600 13px/1 ui-sans-serif,system-ui;letter-spacing:.04em}
.dsh-l2d-wb .wb-state{flex:1;font-size:11.5px;color:#8a8175}
.dsh-l2d-wb .wb-close{font:12px/1 ui-sans-serif,system-ui;padding:7px 14px;border-radius:8px;border:1px solid rgba(78,50,23,.18);background:#fff;color:#2b241d;cursor:pointer}
.dsh-l2d-wb .wb-body{display:grid;grid-template-columns:var(--wb-left,430px) 7px 1fr;min-height:0}
.dsh-l2d-wb .wb-defaults{flex:0 0 auto;margin-top:8px;padding-top:8px;border-top:1px solid rgba(78,50,23,.12)}
.dsh-l2d-wb .wb-defaults h4{margin:0 0 6px;font:600 12px/1.4 ui-sans-serif,system-ui;color:#2b241d}
.dsh-l2d-wb .wb-defaults-row{display:grid;grid-template-columns:1fr 1fr auto;gap:6px;align-items:center}
.dsh-l2d-wb .wb-defaults-row select{padding:3px 6px;border:1px solid rgba(78,50,23,.18);border-radius:6px;background:#fff;font:11.5px/1.4 ui-sans-serif,system-ui;color:#2b241d}
.dsh-l2d-wb .wb-defaults-row button{padding:3px 8px;border:1px solid rgba(78,50,23,.22);border-radius:6px;background:#fff;font:11.5px/1.4 ui-sans-serif,system-ui;cursor:pointer}
.dsh-l2d-wb .wb-defaults-row span{grid-column:1/-1;font-size:10.5px;color:#8a8175}
.dsh-l2d-wb .wb-presets{flex:0 0 auto;display:flex;flex-direction:column;min-height:0;height:var(--wb-presets,170px);padding-top:6px;border-top:1px solid rgba(78,50,23,.12);overflow:hidden}
.dsh-l2d-wb .wb-presets h4{margin:0 0 6px;font:600 12px/1.4 ui-sans-serif,system-ui;color:#2b241d}
.dsh-l2d-wb .wb-preset-new{display:grid;grid-template-columns:88px 1fr 96px auto;gap:6px;align-items:center;margin-bottom:6px;flex:0 0 auto}
.dsh-l2d-wb .wb-preset-new input,.dsh-l2d-wb .wb-preset-new select{width:100%;box-sizing:border-box;padding:3px 6px;border:1px solid rgba(78,50,23,.18);border-radius:6px;background:#fff;font:11.5px/1.4 ui-sans-serif,system-ui;color:#2b241d}
.dsh-l2d-wb .wb-preset-new button{padding:3px 8px;border:1px solid rgba(78,50,23,.22);border-radius:6px;background:#fff;font:11.5px/1.4 ui-sans-serif,system-ui;cursor:pointer}
.dsh-l2d-wb .wb-preset-list{flex:1 1 auto;min-height:0;overflow:auto;border:1px solid rgba(78,50,23,.1);border-radius:8px;padding:2px 6px}
.dsh-l2d-wb .wb-preset-row{display:grid;grid-template-columns:1fr auto auto auto;gap:6px;align-items:center;padding:3px 0;border-bottom:1px solid rgba(78,50,23,.07);font:11.5px/1.5 ui-sans-serif,system-ui;color:#4e4e4e}
.dsh-l2d-wb .wb-preset-name{color:#2b241d}
.dsh-l2d-wb .wb-preset-meta{width:14px;height:14px;line-height:14px;text-align:center;border-radius:50%;background:rgba(78,50,23,.08);color:#8a8175;font-size:10px;cursor:help}
.dsh-l2d-wb .wb-preset-row button{padding:2px 7px;border:1px solid rgba(78,50,23,.18);border-radius:5px;background:#fff;font:11px/1.4 ui-sans-serif,system-ui;cursor:pointer}
.dsh-l2d-wb .wb-left{display:flex;flex-direction:column;gap:8px;padding:12px;border-right:1px solid #e8e2db;min-height:0;overflow:hidden}
.dsh-l2d-wb .wb-left>input[type=text]{font:12px/1.4 ui-sans-serif,system-ui;padding:6px 8px;border-radius:8px;border:1px solid rgba(78,50,23,.18);background:#fff}
.dsh-l2d-wb .wb-list{flex:1 1 auto;min-height:80px;overflow:auto;border:1px solid rgba(78,50,23,.1);border-radius:10px;padding:4px 8px}
.dsh-l2d-wb .wb-recipe{display:flex;flex-direction:column;gap:6px;margin-top:10px;padding-top:10px;border-top:1px solid rgba(78,50,23,.12)}
.dsh-l2d-wb .wb-presets-split{flex:0 0 auto;height:7px;margin:2px 0;border-radius:4px;background:rgba(78,50,23,.06);cursor:row-resize}
.dsh-l2d-wb .wb-presets-split:hover,.dsh-l2d-wb .wb-presets-split.dragging{background:rgba(78,50,23,.16)}
.dsh-l2d-wb .wb-row{display:grid;grid-template-columns:148px 104px 1fr 20px;gap:7px;align-items:center;padding:3px 0}
.dsh-l2d-wb .wb-row[hidden]{display:none}
.dsh-l2d-wb .wb-row input[type=text][data-seeded="1"]{color:#8a8175;font-style:italic}
.dsh-l2d-wb .wb-id{font-family:ui-monospace,monospace;font-size:11px;color:#4e4e4e;overflow:hidden;text-overflow:ellipsis}
.dsh-l2d-wb .wb-id[data-in-rig="1"]{color:#8a5a2b;font-weight:600}
.dsh-l2d-wb .wb-row input[type=text]{font-size:11.5px;padding:3px 6px;border-radius:6px;border:1px solid rgba(78,50,23,.14)}
.dsh-l2d-wb .wb-actions{display:flex;gap:8px;align-items:center;justify-content:flex-end}
.dsh-l2d-wb .wb-generate{font:12px/1 ui-sans-serif,system-ui;padding:8px 14px;border-radius:8px;border:1px solid #2b241d;background:#2b241d;color:#fff;cursor:pointer}
.dsh-l2d-wb .wb-generate:disabled{opacity:.5;cursor:default}
.dsh-l2d-wb .wb-generate.ghost{background:#fff;color:#2b241d}
.dsh-l2d-wb .wb-hint-inline{font-size:11px;color:#8a8175;margin-right:auto}
.dsh-l2d-wb .wb-split{cursor:col-resize;background:#f0ebe5;border-left:1px solid #e8e2db;border-right:1px solid #e8e2db}
.dsh-l2d-wb .wb-split:hover,.dsh-l2d-wb .wb-split.dragging{background:#e2d8cd}
.dsh-l2d-wb .wb-right{position:relative;overflow:hidden;background:radial-gradient(circle at 50% 40%,#faf7f4,#efe9e2 70%)}
.dsh-l2d-wb .wb-stage{position:absolute;inset:0;cursor:grab;touch-action:none}
.dsh-l2d-wb .wb-stage.dragging{cursor:grabbing}
.dsh-l2d-wb .wb-hint{position:absolute;left:14px;bottom:12px;font-size:11.5px;color:#8a8175;pointer-events:none}
body.dsh-l2d-grabbing,body.dsh-l2d-grabbing *{cursor:grabbing !important}`

/** Module-scope singletons; `apply()` is the only writer. */
const S = {
  config: null,
  app: null,
  model: null,
  primary: null,
  seats: new Map(),
  mirrors: new Set(),
  host: new Map(),
  panel: null,
  error: null,
  style: null,
  observers: [],
  frame: 0,
  disposed: false,
  starting: false,
  degraded: false,
  /** Unscaled model height; measured once per model so re-fits stay stable. */
  baseHeight: undefined,
  baseWidth: undefined,
  /** Which stage is mounted: `live2d` (pixi) or `vrm` (three.js). */
  kind: null,
  /** The mounted 3D stage, null for Live2D. */
  vrm: null,
  visibleRel: undefined,
  /** Preset parameter targets the rig does not own: id → { target, current }. */
  extra: new Map(),
  tracks: [],
  visibleSignature: undefined,
  modelLoadedAt: 0,
  dragging: false,
  binding: { version: 1, expressions: {} },
  probe: null,
  /** Per-frame easing factor for parameter targets; `easeMs` on a frame overrides it. */
  easeFactor: 0.2,
  /** Offset used only while the workbench is open; never saved to the layout. */
  workbenchOffset: { x: 0, y: 0 },
  /** Height used only while the workbench is open; `undefined` means use the layout. */
  workbenchHeight: undefined,
  /** Drag offset in CSS pixels, layered over the configured offsets. */
  layout: { model: { x: 0, y: 0 }, bubble: { x: 0, y: 0 } },
  dragBox: null,
  pointerGestures: false,
  /** Live parameter rig: id → eased value. */
  rig: null,
  /** Stamp of the rig table the entries were built from. */
  rigStamp: 0,
  /** Workbench screen and the pane that borrows the stage while it is open. */
  workbench: null,
  workbenchPane: null,
  /** True while the settings page is mounted. */
  settingsOpen: false,
  /** Position slider entries, refreshed after a reset or a drag. */
  layoutSliders: [],
  stageSource: null,
  bubble: null,
  revertTimer: 0,
  lastStage: null,
}

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag)
  for (const [key, value] of Object.entries(props)) {
    if (key === 'style') node.style.cssText = value
    else if (key === 'text') node.textContent = value
    else if (key === 'dataset') Object.assign(node.dataset, value)
    else if (key.startsWith('on')) node.addEventListener(key.slice(2).toLowerCase(), value)
    else node.setAttribute(key, value)
  }
  for (const child of [].concat(children)) if (child) node.append(child)
  return node
}

/** A one-line notice instead of a stack: the common failure has a known cause. */
function showNotice(text) {
  let box = document.querySelector('.dsh-l2d-error')
  if (box === null) {
    box = el('div', { class: 'dsh-l2d-error' })
    document.body.append(box)
  }
  box.textContent = `dsh-live-tavern: ${text}`
  console.warn('[dsh-live-tavern]', text)
}

function showError(error) {
  S.error = error
  const message = error && error.stack ? error.stack : String(error)
  console.error('[dsh-live-tavern-lite]', error)
  let box = document.querySelector('.dsh-l2d-error')
  if (box === null) {
    box = el('div', { class: 'dsh-l2d-error' })
    document.body.append(box)
  }
  box.textContent = `dsh-live-tavern: ${message}`
}

async function fetchJson(url, init) {
  const response = await fetch(url, init)
  if (!response.ok) throw new Error(`${init?.method ?? 'GET'} ${url} → ${response.status} ${await response.text().catch(() => '')}`)
  return response.json()
}

/**
 * Candidate anchors for one placement, best first.
 *
 * The shell is React-rendered and a client plugin activates before it mounts, so
 * a placement can legitimately have no anchor yet. The frame overlay always has
 * `document.body`, which is what makes a graceful degradation possible.
 */
function anchorCandidates(placement) {
  if (placement === 'foreground') return [document.body]
  if (placement === 'sidebar') {
    return [
      document.querySelector('[data-slot="sidebar"]'),
      document.querySelector('[class*="sidebarCol"]'),
    ].filter(Boolean)
  }
  return [
    document.querySelector('[class*="centerCol"]'),
    document.querySelector('[data-slot="main.conversation"]'),
    document.querySelector('[data-slot="main"]'),
  ].filter(Boolean)
}

/** The element a placement seat paints into, or null while the shell mounts. */
function anchorFor(placement) {
  return anchorCandidates(placement)[0] ?? null
}

/**
 * Wait until at least one configured placement has an anchor.
 *
 * @param configured - Placements from config, primary first.
 * @param timeoutMs - How long to wait for the shell before degrading.
 * @returns The placements that are currently available (empty when none are).
 */
async function waitForSeats(configured, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const available = configured.filter(placement => anchorFor(placement) !== null)
    if (available.length > 0) return available
    if (Date.now() >= deadline) return []
    await new Promise(resolve => setTimeout(resolve, 120))
  }
}

function ensureSeat(placement) {
  const anchor = anchorFor(placement)
  if (anchor === null) return null
  if (placement !== 'foreground' && anchor.getAttribute('data-dsh-l2d-anchor') === null) {
    anchor.setAttribute('data-dsh-l2d-anchor', placement)
    S.seats.set(`mark:${placement}`, { marker: true, anchor })
  }
  const existing = S.seats.get(placement)
  if (existing && !existing.marker && existing.anchor === anchor && existing.node.isConnected) return existing.node
  existing?.node?.remove()
  const node = el('div', { class: 'dsh-l2d-seat', dataset: { placement } })
  anchor.append(node)
  S.seats.set(placement, { marker: false, anchor, node })
  return node
}

function mountCanvasHost(seat, placement) {
  const host = el('div', { class: 'dsh-l2d-host' })
  host.dataset.placement = placement
  seat.append(host)
  return host
}

/**
 * How much of the sprite's own box the artwork actually fills, as fractions.
 *
 * A Live2D canvas often carries wide empty margins, and a model whose art fills a
 * landscape canvas would otherwise be sized by height alone and cover the whole
 * interface. One low-resolution capture after load measures what is really drawn.
 *
 * @returns Nothing; the result is stored on `S.visibleRel`.
 */
function measureVisible() {
  const app = S.app
  const model = S.model
  if (!app || !model) return
  if (S.visibleRel !== undefined) return
  try {
    const canvas = app.renderer.extract.canvas({ target: model, resolution: 0.1 })
    const context = canvas.getContext('2d', { willReadFrequently: true })
    const { width, height } = canvas
    const pixels = context?.getImageData(0, 0, width, height).data
    if (pixels === undefined) return
    let left = width
    let right = -1
    let top = height
    let bottom = -1
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        if (pixels[(y * width + x) * 4 + 3] <= 8) continue
        if (x < left) left = x
        if (x > right) right = x
        if (y < top) top = y
        if (y > bottom) bottom = y
      }
    }
    if (right < left || bottom < top) return
    S.visibleRel = {
      left: left / width,
      top: top / height,
      // One pixel of slack keeps a hairline from being scaled to nothing.
      width: (right - left + 1) / width,
      height: (bottom - top + 1) / height,
    }
  } catch {
    // Extraction is a nicety: without it the fit falls back to the sprite box.
  }
}

/**
 * Place the character so the drawn artwork — not the sprite's empty margin — is
 * `height`-ratio tall and never wider than the configured share of the stage.
 */
function fitModel() {
  const app = S.app
  const model = S.model
  if (!app || !model) return
  // `model.height` reports the SCALED height, so measuring it again after a fit
  // would multiply the scale on every re-fit — and the layout watcher re-fits on
  // every chat mutation. Measure the unscaled bounds once per model instead.
  if (S.baseHeight === undefined) {
    S.baseHeight = (model.height || 1) / (model.scale.y || 1)
    S.baseWidth = (model.width || 1) / (model.scale.x || 1)
  }
  const { width, height } = app.screen
  // Every seat is a viewport-sized fixed layer, so `app.screen` is the viewport
  // in all three placements and these numbers come out identical: switching
  // placement changes which layer paints her, never where she stands.
  const heightRatio = Number(S.workbenchPane === null ? S.layout.height : (S.workbenchHeight ?? S.layout.height))
  const target = height * (Number.isFinite(heightRatio) ? heightRatio : 0.92)
  const rel = S.visibleRel ?? { left: 0, top: 0, width: 1, height: 1 }
  const baseWidth = S.baseWidth || 1
  const baseHeight = S.baseHeight || 1
  const visibleWidth = baseWidth * rel.width
  const capRatio = Number(S.config?.widthCap)
  const maxWidth = width * (Number.isFinite(capRatio) ? Math.min(1, Math.max(0.2, capRatio)) : 0.6)
  // Height sets the size exactly as before; width only ever shrinks it. A wide
  // illustration therefore stops at the cap instead of covering the conversation,
  // while a normal portrait keeps the size the user already tuned.
  const byHeight = target / (baseHeight || 1)
  const byWidth = maxWidth / (visibleWidth || 1)
  const ratio = Math.min(byHeight, byWidth)
  model.scale.set(ratio)
  model.anchor.set(0.5, 1)
  const shift = S.workbenchPane === null ? { x: 0, y: 0 } : S.workbenchOffset
  // The artwork's own bottom and centre are not the sprite's: shift the sprite so
  // the drawn feet sit on the stage's bottom edge and the drawn body is centred.
  const bottomGap = (1 - (rel.top + rel.height)) * baseHeight * ratio
  const centreShift = (rel.left + rel.width / 2 - 0.5) * baseWidth * ratio
  model.position.set(
    width / 2 + S.layout.model.x + shift.x - centreShift,
    height + S.layout.model.y + shift.y + bottomGap,
  )
  model.alpha = S.config.opacity
  if (S.bubble !== null && S.bubble.dataset.show === '1') positionBubble()
}

const LAYOUT_KEY = 'dsh-live-tavern-lite-layout'

/**
 * Layout tweaks live in `localStorage`, not in the shared settings file.
 *
 * They are per-browser view adjustments — the same person may want the character
 * somewhere else on another machine — and keeping them out of `settings.json`
 * means a settings save can never reset the position.
 */
/**
 * The layout a fresh page starts with.
 *
 * One shape, one place: a reset that built its own object dropped `height`, and
 * the slider then showed NaN for it.
 *
 * @returns A layout with every key the block and the fit read.
 */
function defaultLayout() {
  return { model: { x: 0, y: 0 }, bubble: { x: 0, y: 0 }, height: 0.92 }
}

function readLayout() {
  const blank = defaultLayout()
  try {
    const raw = JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? 'null')
    if (raw === null || typeof raw !== 'object') return blank
    for (const key of ['model', 'bubble']) {
      const part = raw[key]
      if (part !== null && typeof part === 'object'
        && Number.isFinite(Number(part.x)) && Number.isFinite(Number(part.y))) {
        blank[key] = { x: Number(part.x), y: Number(part.y) }
      }
    }
    if (Number.isFinite(Number(raw.height))) blank.height = Number(raw.height)
  } catch {
    // A malformed entry only means the stage starts at its configured position.
  }
  return blank
}

function saveLayout() {
  try {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify(S.layout))
  } catch {
    // Private-mode storage may reject writes; the stage still moved.
  }
}

/** Return both the model and the bubble to their default placement. */
function resetLayout(reason = 'manual') {
  console.info('[dsh-live-tavern] resetting the whole layout', reason)
  S.layout = defaultLayout()
  saveLayout()
  fitModel()
  if (S.bubble !== null && S.bubble.dataset.show === '1') positionBubble()
  renderLayoutBlock()
}

/**
 * The character's rectangle on screen, in CSS pixels.
 *
 * Derived from the placed transform, not from the engine: the engine reports the
 * stage, and the artwork canvas carries transparent margins. `visibleOffset` also
 * measures the pixels, but a rectangle is enough for a hit test and costs nothing
 * per pointer event.
 *
 * @returns `{ left, top, width, height }`, or undefined before the model loads.
 */
function modelScreenRect() {
  if (S.kind === 'vrm') return vrmScreenRect()
  if (!S.app || !S.model) return undefined
  const rect = S.app.canvas.getBoundingClientRect()
  const scale = Math.abs(S.model.scale.y || 1)
  const factor = Number(S.config?.hitBoxScale)
  const reach = Number.isFinite(factor) ? Math.min(2, Math.max(0.2, factor)) : 1
  const rel = S.visibleRel ?? { left: 0, top: 0, width: 1, height: 1 }
  const width = (S.baseWidth || 0) * rel.width * scale * reach
  const height = (S.baseHeight || 0) * rel.height * scale * reach
  if (!(width > 2) || !(height > 2)) return undefined
  // Scaled around her feet: a bigger hit box grows upward and sideways, never
  // off the ground she stands on.
  const centreShift = (rel.left + rel.width / 2 - 0.5) * (S.baseWidth || 0) * scale
  return {
    left: rect.left + rect.width / 2 + S.layout.model.x - centreShift - width / 2,
    top: rect.top + rect.height + S.layout.model.y - height,
    width,
    height,
  }
}

/** Whether a pointer event landed on her body. */
function isModelHit(event) {
  const area = modelScreenRect()
  if (area === undefined) return false
  const x = event.clientX
  const y = event.clientY
  return x >= area.left && x <= area.left + area.width && y >= area.top && y <= area.top + area.height
}

/**
 * After the model loads, check that something was actually drawn.
 *
 * "Loaded" and "visible" are different failures, and only the second one leaves the
 * player with an empty stage and a working bubble. The check samples the rendered
 * frame once, records the opaque ratio, and says so in the interface when the frame
 * is empty — a silent blank canvas is the worst outcome for a diagnostic.
 */
function verifyRender() {
  if (S.kind === 'vrm') {
    const stage = S.vrm
    const report = { stage: 'vrm', drew: (stage?.frames ?? 0) > 0, frames: stage?.frames ?? 0, textures: 0, channels: stage?.channelCount ?? null, missing: stage?.missing?.slice(0, 12) ?? null }
    S.renderReport = report
    reportStatus({ draw: report })
    if (report.drew === false) showNotice('VRM 已加载但一帧都没画出来：刷新页面试试')
    return
  }
  const app = S.app
  const model = S.model
  if (!app || !model) return
  const report = { opaque: 0, samples: 0, drew: false, glLost: null, textures: 0 }
  try {
    report.textures = Array.isArray(model.textures) ? model.textures.length : 0
    const gl = app.renderer?.gl
    report.glLost = typeof gl?.isContextLost === 'function' ? gl.isContextLost() : null
    const canvas = app.renderer.extract.canvas({ target: app.stage, resolution: 0.15 })
    const context = canvas.getContext('2d', { willReadFrequently: true })
    const pixels = context?.getImageData(0, 0, canvas.width, canvas.height).data
    if (pixels !== undefined) {
      for (let index = 3; index < pixels.length; index += 4 * 7) {
        report.samples += 1
        if (pixels[index] > 8) report.opaque += 1
      }
      report.drew = report.opaque > 0
    }
  } catch (error) {
    report.error = String(error?.message ?? error)
  }
  report.textureSizes = (() => {
    try {
      return (model.textures ?? []).map(texture => {
        const source = texture?.source?.resource ?? texture?.source
        return { width: source?.width ?? null, height: source?.height ?? null }
      })
    } catch {
      return []
    }
  })()
  report.log = S.engineLog ?? []
  S.renderReport = report
  // The load-time report runs before this sample exists, so send a second one.
  reportStatus({ draw: report })
  if (report.drew === false && report.error === undefined) {
    showNotice(report.glLost === true
      ? '模型的 WebGL 上下文丢失了：刷新页面可以恢复'
      : '模型已加载但没有画出内容：纹理可能没取到，刷新试试')
  } else {
    document.querySelector('.dsh-l2d-error')?.remove()
  }
}

/**
 * Click and drag gestures on the model, without an overlay.
 *
 * The previous version pinned a transparent element over her body, which meant she
 * swallowed every click in that rectangle. This listens on the document instead and
 * only acts when the pointer is inside her silhouette — the same arrangement the
 * whale widget uses — so anything outside her passes straight through. A press that
 * travels further than {@link DRAG_THRESHOLD} is a drag; anything shorter is a tap,
 * and two taps in quick succession reset the layout.
 */
const DRAG_THRESHOLD = 4
const DOUBLE_TAP_MS = 320

let pressState = null
let lastTapAt = 0

function onModelPointerDown(event) {
  if (event.button !== 0) return
  // Seats that paint above the content only: in the chat column the transcript
  // covers her, so a hit there cannot happen anyway.
  const seat = S.primary?.placement
  if (seat === undefined || seat === 'chat') return
  if (S.settingsOpen || S.workbenchPane !== null) return
  if (!isModelHit(event)) return
  event.preventDefault()
  try {
    document.body.setPointerCapture?.(event.pointerId)
  } catch {
    // Capture is best-effort; the document listeners below are the fallback.
  }
  pressState = {
    x: event.clientX,
    y: event.clientY,
    ox: S.layout.model.x,
    oy: S.layout.model.y,
    moved: 0,
  }
  S.dragging = true
  document.body.classList.add('dsh-l2d-grabbing')
}

function onModelPointerMove(event) {
  if (pressState === null) return
  pressState.moved = Math.max(pressState.moved, Math.hypot(event.clientX - pressState.x, event.clientY - pressState.y))
  if (pressState.moved < DRAG_THRESHOLD) return
  S.layout.model = {
    x: pressState.ox + (event.clientX - pressState.x),
    y: pressState.oy + (event.clientY - pressState.y),
  }
  // One refit per frame: the 3D fit measures a bounding box, which is far too much
  // work to do on every pointermove.
  if (pressState.queued === true) return
  pressState.queued = true
  requestAnimationFrame(() => {
    if (pressState !== null) pressState.queued = false
    if (S.kind === 'vrm') fitVrm()
    else fitModel()
  })
}

function onModelPointerUp(event) {
  if (pressState === null) return
  const moved = pressState.moved
  pressState = null
  S.dragging = false
  // Re-anchor the fall at the dropped position: dragging chooses where she stands, it must
  // never be undone by gravity the moment the pointer is released.
  const stage = S.vrm
  if (stage !== null && stage !== undefined && stage.gravity !== undefined && stage.gravity !== null && stage.vrm !== null) {
    stage.gravity.base = (stage.pivot?.position.y ?? 0) + stage.vrm.scene.position.y
    stage.gravity.offset = 0
    stage.gravity.velocity = 0
    // Let the next frame re-derive the floor from where her feet ended up.
    stage.floorY = null
  }
  document.body.classList.remove('dsh-l2d-grabbing')
  if (moved >= DRAG_THRESHOLD) {
    saveLayout()
    renderLayoutBlock()
    if (S.kind === 'vrm') fitVrm()
    else fitModel()
    pingInteraction('drag')
    return
  }
  // A tap: two of them close together is the reset gesture.
  const now = Date.now()
  const doubled = now - lastTapAt < DOUBLE_TAP_MS
  lastTapAt = doubled ? 0 : now
  if (doubled) {
    resetLayout('double-tap on the stage')
    return
  }
  pingInteraction('tap')
}

/** Bind the gesture listeners once, on the document. */
function installPointerGestures() {
  if (S.pointerGestures === true) return
  S.pointerGestures = true
  document.addEventListener('pointerdown', onModelPointerDown, true)
  document.addEventListener('pointermove', onModelPointerMove, true)
  document.addEventListener('pointerup', onModelPointerUp, true)
  document.addEventListener('pointercancel', onModelPointerUp, true)
}

/**
 * Tell the Host the player touched her.
 *
 * Only the cross-session mode has a judge to answer, so the request is skipped
 * when that switch is off; the Host re-checks anyway. A failure stays silent: a
 * pointer should never produce an error banner.
 *
 * @param kind - `tap` for a press without movement, `drag` for a moved model.
 */
function pingInteraction(kind) {
  if (S.config?.interaction !== true || S.config?.director !== true) return
  void fetchJson(`${API}/interact`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ kind }),
  }).catch((error) => {
    // A refused interaction is worth a console line, never a banner.
    console.info('[dsh-live-tavern] interaction refused', error?.message ?? error)
  })
}

/**
 * The VRM stage: a second engine beside the Live2D one.
 *
 * A VRM is a glTF with a humanoid skeleton and a fixed set of expressions, so the
 * mapping is short and honest: an emotion becomes expression weights, `line` goes to
 * the same bubble, and a tap or drag works through the same hit rectangle. Nothing
 * of the Live2D parameter machinery runs here — there are no `Param*` channels to
 * drive — so the two stages share everything except their renderer.
 */

/**
 * Bone channels a 3D model can be driven through.
 *
 * The names use the same grammar as the Live2D parameters — `BoneHeadY=12@300` reads
 * the same as `ParamAngleY=12@300` — so one `animation` string works on both stages.
 * Values are degrees.
 */
const VRM_BONES = {
  BoneHeadX: ['head', 'x'],
  BoneHeadY: ['head', 'y'],
  BoneHeadZ: ['head', 'z'],
  BoneNeckY: ['neck', 'y'],
  BoneSpineX: ['spine', 'x'],
  BoneSpineY: ['spine', 'y'],
  BoneSpineZ: ['spine', 'z'],
  BoneChestZ: ['chest', 'z'],
  BoneHipsY: ['hips', 'y'],
  BoneLeftUpperArmZ: ['leftUpperArm', 'z'],
  BoneRightUpperArmZ: ['rightUpperArm', 'z'],
}

/** Degrees → radians, for the bone channels above. */
const DEG = Math.PI / 180

/** Scratch vector for foot-height probes; reused so the render loop allocates nothing. */
const GROUND_VEC = new THREE.Vector3()

/** Preset expression weights per emotion prototype. Values are scaled by intensity. */
const VRM_EMOTIONS = {
  neutral: { neutral: 0.4 },
  calm: { relaxed: 0.6 },
  sleepy: { relaxed: 0.5 },
  joy: { happy: 0.9 },
  tender: { happy: 0.4, relaxed: 0.3 },
  shy: { relaxed: 0.5, happy: 0.2 },
  smug: { happy: 0.6, surprised: 0.1 },
  curious: { surprised: 0.35 },
  surprise: { surprised: 0.9 },
  annoyed: { angry: 0.45 },
  anger: { angry: 0.9 },
  sad: { sad: 0.8 },
  lonely: { sad: 0.6, relaxed: 0.2 },
  fear: { surprised: 0.6, angry: 0.2 },
}

/** VRM payloads already fetched in this page: url → ArrayBuffer. */
const VRM_CACHE = new Map()
/** In-flight downloads, so a preload and the stage never fetch twice. */
const VRM_PENDING = new Map()

/**
 * Download a VRM once, reporting progress.
 *
 * The file is 17 MB and the browser cache only helps the second time, so the bytes
 * are fetched as a stream: the stage then parses from memory instead of opening a
 * second request, and a repeat mount in the same page costs nothing.
 *
 * @param url - The `.vrm` URL from `/config`.
 * @param onProgress - Called with `0..1` while the body arrives.
 * @returns The file as an ArrayBuffer.
 */
async function fetchVrm(url, onProgress) {
  const cached = VRM_CACHE.get(url)
  if (cached !== undefined) {
    onProgress?.(1)
    return cached
  }
  const pending = VRM_PENDING.get(url)
  if (pending !== undefined) return pending
  const task = (async () => {
    const response = await fetch(url, { cache: 'force-cache' })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const total = Number(response.headers.get('content-length')) || 0
    let buffer
    if (response.body === null || total === 0) {
      buffer = await response.arrayBuffer()
      onProgress?.(1)
    } else {
      const reader = response.body.getReader()
      const chunks = []
      let received = 0
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        chunks.push(value)
        received += value.length
        onProgress?.(Math.min(1, received / total))
      }
      buffer = new Uint8Array(received)
      let at = 0
      for (const chunk of chunks) {
        buffer.set(chunk, at)
        at += chunk.length
      }
      buffer = buffer.buffer
    }
    VRM_CACHE.set(url, buffer)
    return buffer
  })()
  VRM_PENDING.set(url, task)
  try {
    return await task
  } finally {
    VRM_PENDING.delete(url)
  }
}

/** Warm the download while the seat is still being waited for. */
function preloadVrm(config) {
  if (config?.stageKind !== 'vrm') return
  const url = config?.selected?.entryUrl
  if (typeof url !== 'string' || url === '') return
  void fetchVrm(url).catch((error) => {
    console.info('[dsh-live-tavern] vrm preload failed', error?.message ?? error)
  })
}

/**
 * Scale how strongly the model's spring bones react.
 *
 * A VRM 0.x author may ship `gravityPower: 0` and `stiffness: 0.93`, which is
 * physically almost rigid: hair and cloth keep their authored shape and only twitch
 * when the head moves. The authored values are the baseline; the setting adds droop
 * (gravity) and softens the chain above 1, and stiffens it below.
 *
 * @param vrmStage - The mounted 3D stage.
 */
function applySpringStrength(vrmStage) {
  const manager = vrmStage?.vrm?.springBoneManager
  if (manager === undefined || manager === null) return 0
  const joints = manager.joints instanceof Set ? [...manager.joints] : []
  if (joints.length === 0) return 0
  // Capture the authored numbers once; every later call scales from them.
  if (vrmStage.springBase === undefined) {
    vrmStage.springBase = joints
      .map(joint => (joint?.settings === undefined ? null : {
        settings: joint.settings,
        gravityPower: Number(joint.settings.gravityPower) || 0,
        stiffness: Number(joint.settings.stiffness) || 0,
        dragForce: Number(joint.settings.dragForce) || 0,
      }))
      .filter(entry => entry !== null)
  }
  const factor = Number(S.config?.springStrength)
  const strength = Number.isFinite(factor) ? Math.min(5, Math.max(0, factor)) : 1
  const extra = Number(S.config?.springGravity)
  const gravity = Number.isFinite(extra) ? Math.min(20, Math.max(0, extra)) : 0
  const delta = strength - 1
  for (const entry of vrmStage.springBase) {
    // Gravity decides how hard the chain is pulled down, stiffness how far it travels,
    // and a lower drag lets the motion actually get there.
    entry.settings.gravityPower = entry.gravityPower + gravity + delta * 1.6
    entry.settings.stiffness = entry.stiffness / (0.35 + 0.65 * strength)
    entry.settings.dragForce = Math.max(0.05, entry.dragForce * (1 - delta * 0.22))
  }
  vrmStage.springJoints = joints.length
  return joints.length
}

/**
 * Drop MToon outline passes that have no usable width.
 *
 * A VRM 0.x material without `outlineWidth` still gets an outline material from the
 * converter, whose vertex offset then evaluates to NaN: the hull covers the whole
 * viewport as a black sheet. An outline the model actually declares is kept.
 *
 * @param vrm - The loaded VRM.
 * @returns How many outline materials were removed, for diagnostics.
 */
function repairVrmOutlines(vrm) {
  let removed = 0
  vrm.scene.traverse((object) => {
    if (object.isMesh !== true || !Array.isArray(object.material)) return
    const kept = object.material.filter((material) => {
      if (material?._isOutline !== true) return true
      const declared = Number(material.outlineWidth ?? material.uniforms?.outlineWidth?.value)
      if (Number.isFinite(declared) && declared > 0) return true
      removed += 1
      return false
    })
    if (kept.length === object.material.length) return
    object.material = kept.length === 1 ? kept[0] : kept
  })
  return removed
}

/**
 * Repair the transparency some baked VRM 0.x models rely on.
 *
 * Their atlases carry an alpha channel while the materials declare `OPAQUE`, which is
 * legal glTF and means "ignore alpha". A body built from hair cards then draws the
 * empty part of every card as a black rectangle — in a viewer that clamps by alpha it
 * looks fine, in a faithful renderer it is a black sheet over the interface.
 *
 * The fix is per material and conservative: honour `MASK` / `BLEND` as declared, and
 * give `OPAQUE` materials a texture-only alpha cutout, which changes nothing for a
 * texture that is fully opaque.
 *
 * @param gltf - The parsed glTF, whose parser exposes the raw material list.
 * @returns How many materials were adjusted, for diagnostics.
 */
function repairVrmAlpha(gltf) {
  const json = gltf?.parser?.json
  const associations = gltf?.parser?.associations
  if (json === undefined || associations === undefined) return 0
  const declared = Array.isArray(json.materials) ? json.materials : []
  let changed = 0
  for (const [object, association] of associations) {
    const index = association?.materials
    if (typeof index !== 'number') continue
    const material = object
    if (material === null || typeof material !== 'object') continue
    // MToon owns its own alpha handling; only the plain materials need this.
    if (typeof material.isMToonMaterial === 'boolean' && material.isMToonMaterial) continue
    if (material.map === null || material.map === undefined) continue
    const raw = declared[index] ?? {}
    const mode = typeof raw.alphaMode === 'string' ? raw.alphaMode : 'OPAQUE'
    if (mode === 'MASK') {
      material.alphaTest = Math.max(0.01, Number(raw.alphaCutoff) || 0.5)
    } else if (mode === 'BLEND') {
      material.transparent = true
      material.depthWrite = false
    } else {
      material.alphaTest = 0.5
      material.transparent = false
      material.depthWrite = true
    }
    material.needsUpdate = true
    changed += 1
  }
  return changed
}

/**
 * Mount a VRM in the same seat the Live2D stage uses.
 *
 * @param config - The `/config` payload; `selected.entryUrl` names the `.vrm`.
 */
async function startVrmEngine(config) {
  const available = await waitForSeats(config.placement)
  const primaryPlacement = config.placement[0] ?? (available[0] ?? 'foreground')
  const seat = ensureSeat(primaryPlacement)
  if (seat === null) {
    showError(new Error(`舞台坐席 '${primaryPlacement}' 在页面里没有找到锚点元素。`))
    return
  }
  const host = mountCanvasHost(seat, primaryPlacement)
  S.primary = { placement: primaryPlacement, host }
  S.kind = 'vrm'

  const maskText = el('span', { text: `载入 ${config.selected.id} …` })
  const mask = el('div', { class: 'dsh-l2d-mask' })
  mask.append(maskText)
  seat.append(mask)
  const showProgress = (fraction) => {
    if (!(fraction >= 0)) return
    maskText.textContent = `载入 ${config.selected.id} … ${Math.round(fraction * 100)}%`
  }

  const box = sizeOf(host)
  const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
  renderer.setSize(box.width, box.height, false)
  renderer.setClearColor(0x000000, 0)
  renderer.outputColorSpace = THREE.SRGBColorSpace
  host.append(renderer.domElement)
  const canvas = renderer.domElement
  canvas.style.width = '100%'
  canvas.style.height = '100%'
  canvas.style.display = 'block'

  const scene = new THREE.Scene()
  const camera = new THREE.OrthographicCamera(-box.width / 2, box.width / 2, box.height / 2, -box.height / 2, 0.1, 4000)
  camera.position.set(0, 0, 1200)
  scene.add(new THREE.AmbientLight(0xffffff, 1.1))
  const key = new THREE.DirectionalLight(0xffffff, 1.0)
  key.position.set(-0.4, 1, 1.2)
  scene.add(key)

  const clock = new THREE.Clock()
  const stage = {
    renderer,
    scene,
    camera,
    canvas,
    vrm: null,
    frames: 0,
    /** Expression weights the frame asks for, eased in the render loop. */
    target: new Map(),
    current: new Map(),
    blinkAt: 0,
    nextBlink: performance.now() + 2500,
    raf: 0,
    /** Workbench slider values: channel id → degrees. */
    probe: new Map(),
    /** Bone channels pinned by a frame or a preset: channel id → degrees. */
    pinned: new Map(),
    /** Expression names pinned by `Expr:` channels: name → value. */
    exprPinned: new Map(),
    /** Running bone tracks. */
    tracks: [],
    /** Bone channel id → { node, axis, rest }. */
    bones: new Map(),
  }
  S.vrm = stage

  const loader = new GLTFLoader()
  loader.register(parser => new VRMLoaderPlugin(parser))
  let gltf
  try {
    const bytes = await fetchVrm(config.selected.entryUrl, showProgress)
    maskText.textContent = `解析 ${config.selected.id} …`
    gltf = await new Promise((resolve, reject) => {
      loader.parse(bytes, '', resolve, reject)
    })
  } catch (error) {
    mask.remove()
    showError(new Error(`VRM 载入失败：${error?.message ?? error}`))
    return
  }
  const vrm = gltf.userData.vrm
  if (vrm === undefined) {
    mask.remove()
    showError(new Error('这个文件不是 VRM：glTF 里没有 VRM 扩展。'))
    return
  }
  VRMUtils.removeUnnecessaryVertices(gltf.scene)
  VRMUtils.combineSkeletons(gltf.scene)
  // VRM 0.x models face the camera's back; the util is a no-op for 1.0.
  VRMUtils.rotateVRM0(vrm)
  // Baked VRM 0.x packs often declare OPAQUE while their atlas has an alpha channel;
  // without a cutout the empty part of each card draws as a black sheet.
  stage.materialsFixed = repairVrmAlpha(gltf)
  stage.outlinesRemoved = repairVrmOutlines(vrm)
  vrm.scene.traverse((object) => { object.frustumCulled = false })
  stage.vrm = vrm
  // The spring joints are built during an update, and the stage must already own the VRM:
  // applying the strength before this point silently did nothing until a settings save.
  try {
    vrm.update(0)
  } catch {
    // A pose that has not settled yet is not a failure.
  }
  stage.springJoints = applySpringStrength(stage)
  // The model sits inside a pivot: the pivot carries the drag offsets, the model
  // keeps one fixed fit transform. Moving one does not disturb the other.
  stage.pivot = new THREE.Group()
  stage.pivot.add(vrm.scene)
  scene.add(stage.pivot)
  // The rest pose is the reference: a channel value is an offset from it, so a nod
  // never drifts the character's posture.
  // A one-shot handshake with the Host: it tells us whether the page is running a bundle
  // that knows about pose checks at all.
  void fetchJson(`${API}/checks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ recipe: null, results: [], diag: 'vrm-engine-ready' }),
  }).catch(() => {})
  stage.bones = new Map()
  // The Host parsed this model's own humanoid bones; bind those. The curated list is a
  // fallback for a pack whose file could not be read.
  const declared = Array.isArray(S.config?.selected?.channels) ? S.config.selected.channels : []
  const channels = declared.length > 0
    ? declared.map(entry => [entry.id, entry.bone, entry.axis])
    : Object.entries(VRM_BONES).map(([id, [bone, axis]]) => [id, bone, axis])
  stage.missing = []
  for (const [channel, boneName, axis] of channels) {
    const node = vrm.humanoid?.getNormalizedBoneNode?.(boneName) ?? null
    if (node === null || node === undefined) {
      stage.missing.push(channel)
      continue
    }
    if (axis !== 'x' && axis !== 'y' && axis !== 'z') continue
    stage.bones.set(channel, { node, axis, rest: node.rotation[axis] })
  }
  stage.channelCount = stage.bones.size
  // Standing reference for geometric checks: a pose is judged against the rest height.
  stage.restFrame = { headY: 1.6, footY: 0 }
  // A crouch lowers the hips; rotations alone cannot move the body down.
  const hips = vrm.humanoid?.getNormalizedBoneNode?.('hips') ?? null
  stage.hips = hips;
  stage.hipsRest = hips === null || hips === undefined ? null : hips.position.clone()
  stage.tracks = []
  // A real floor object the avatar stands on: she may leave it (a jump) and is only pushed
  // back up when a pose would push her feet through it.
  stage.groundLock = true
  stage.floorY = null
  /** Simulated vertical motion of the whole body, in scene units per second. */
  stage.gravity = { acceleration: -9.8 * 100, velocity: 0, offset: 0, base: null }
  fitVrm()

  /**
   * World Y of the lower foot, in the scene space the floor lives in.
   *
   * @param stage - The running VRM stage.
   * @returns The lowest foot height, or null when the rig has no feet.
   */
  function lowestFootY(stage) {
    const humanoid = stage.vrm?.humanoid
    if (humanoid === undefined || humanoid === null) return null
    let lowest = Infinity
    for (const name of ['leftFoot', 'rightFoot']) {
      const foot = humanoid.getNormalizedBoneNode?.(name) ?? null
      if (foot === null || foot === undefined) continue
      foot.updateWorldMatrix(true, false)
      foot.getWorldPosition(GROUND_VEC)
      if (GROUND_VEC.y < lowest) lowest = GROUND_VEC.y
    }
    return Number.isFinite(lowest) ? lowest : null
  }

  /**
   * Derive the scale-dependent physics constants once the model is fitted.
   *
   * There is no visible ground: the stage background is the ground, and a dark plane behind her
   * legs reads as a stray black line. Landing still needs a measured foot height, which
   * `floorY` holds.
   *
   * @param stage - The running VRM stage.
   */
  function ensureFloor(stage) {
    if (stage.floor !== undefined) return
    const root = stage.vrm?.scene
    if (root === undefined || root === null || stage.baseSize === undefined) return
    const scale = Math.abs(root.scale.x) || 1
    stage.floor = null
    stage.floorGrid = null
    // floorY stays null until the first frame measures a foot; the bounding box bottom is
    // not the sole of the shoe, and using it made her hover and twitch on every frame.
    stage.floorY = null
    // The scene is scaled to screen pixels, so convert m/s² into scene units: one model
    // height (about 1.6 m) is baseSize.y × scale units.
    const heightUnits = stage.baseSize.y * scale
    if (heightUnits > 1) {
      stage.gravity.acceleration = -9.8 * (heightUnits / 1.6)
      // One metre in scene units, so an impulse given in m/s lands at the right speed.
      stage.unitsPerMetre = heightUnits / 1.6
    }
  }

  fitVrm()
  stage.mask = mask
  stage.maskText = maskText
  maskText.textContent = `绘制 ${config.selected.id} …`

  stage.raf = requestAnimationFrame(function tick() {
    if (S.vrm !== stage) return
    stage.raf = requestAnimationFrame(tick)
    const delta = Math.min(0.1, clock.getDelta())
    // Pinned channels hold without a track; tracks layer on top of them.
    if (!(stage.pinnedEased instanceof Map)) stage.pinnedEased = new Map()
    for (const [id, degrees] of stage.pinned ?? []) {
      const bone = stage.bones.get(id)
      if (bone === undefined) continue
      if (stage.tracks.some(channel => channel.id === id)) continue
      const now = stage.pinnedEased.get(id)
      const next = now === undefined ? bone.node.rotation[bone.axis] / DEG : now
      const eased = next + (degrees - next) * S.easeFactor
      stage.pinnedEased.set(id, eased)
      bone.node.rotation[bone.axis] = bone.rest + eased * DEG
    }
    // A channel that leaves the frame must not freeze where it stopped. Dropping the
    // eased value alone left the bone rotated, so the next pose was painted on top of
    // the last one; eases back to rest instead.
    for (const [id, eased] of [...stage.pinnedEased]) {
      if (stage.pinned?.has(id) ?? false) continue
      const bone = stage.bones.get(id)
      if (bone === undefined) {
        stage.pinnedEased.delete(id)
        continue
      }
      if (stage.tracks.some(channel => channel.id === id)) continue
      const next = eased + (0 - eased) * S.easeFactor
      if (Math.abs(next) < 0.05) {
        stage.pinnedEased.delete(id)
        bone.node.rotation[bone.axis] = bone.rest
        continue
      }
      stage.pinnedEased.set(id, next)
      bone.node.rotation[bone.axis] = bone.rest + next * DEG
    }
    // Body offset (a crouch), in metres relative to the hips' rest position.
    // `HipsY=…@ms` inside `animation` animates that offset, so a bounce can keyframe the
    // whole body instead of pinning one static crouch per call.
    if (stage.hipsTrack !== null && stage.hipsTrack !== undefined) {
      const stepped = stepTracks([stage.hipsTrack], performance.now())
      const channel = stepped.values.get(stage.hipsTrack.id)
      if (channel !== undefined) stage.hipsAnimatedY = channel.value
      if (!stepped.active) stage.hipsTrack = null
    }
    // Whole-body travel across the stage, in metres. Separate from `HipsY` because walking
    // and turning are placement, not pose: no bone rotation can produce them.
    if (stage.moveTrack !== null && stage.moveTrack !== undefined) {
      const stepped = stepTracks([stage.moveTrack], performance.now())
      const channel = stepped.values.get(stage.moveTrack.id)
      if (channel !== undefined) {
        if (stage.moveTrack.id === 'MoveX') stage.moveX = channel.value
        else stage.moveZ = channel.value
      }
      if (!stepped.active) stage.moveTrack = null
      const root = stage.vrm?.scene
      if (root !== undefined && root !== null) {
        root.position.x = Number(stage.moveX ?? 0)
        root.position.z = Number(stage.moveZ ?? 0)
      }
    }
    if (stage.hips !== null && stage.hips !== undefined && stage.hipsRest !== null && stage.hipsRest !== undefined) {
      const offset = stage.translate?.['hips']
      const animated = Number(stage.hipsAnimatedY ?? 0)
      if ((Array.isArray(offset) && offset.length === 3) || animated !== 0) {
        stage.hips.position.set(
          stage.hipsRest.x + Number(offset?.[0] ?? 0),
          stage.hipsRest.y + Number(offset?.[1] ?? 0) + animated,
          stage.hipsRest.z + Number(offset?.[2] ?? 0),
        )
      } else if (!stage.hips.position.equals(stage.hipsRest)) {
        stage.hips.position.copy(stage.hipsRest)
      }
    }
    // Workbench sliders write here, so the render loop cannot drop them.
    if (stage.probe instanceof Map) {
      for (const [id, degrees] of stage.probe) {
        const bone = stage.bones.get(id)
        if (bone === undefined) continue
        bone.node.rotation[bone.axis] = bone.rest + degrees * DEG
      }
    }
    const now = performance.now()
    if (stage.pendingChecks !== undefined && stage.pendingChecks !== null && now >= stage.pendingChecks.due) {
      const paused = stage.pendingChecks
      stage.pendingChecks = null
      reportVrmChecks({ checks: paused.checks, recipe: paused.recipe })
    }
    stepVrmTracks(performance.now())
    easeVrmExpressions(delta)
    vrm.update(delta)
    // Body facing: eased yaw of the model root, so a turn is a real turn of the whole rig.
    if (stage.turnTrack !== undefined && stage.turnTrack !== null) {
      // 多关键帧轨道：按累计毫秒插值，走完停在最后一条。
      const track = stage.turnTrack
      const elapsed = performance.now() - track.start
      let acc = 0
      let prev = track.from
      let value = null
      for (const entry of track.entries) {
        const span = Math.max(1, Number(entry.ms) || 100)
        if (elapsed <= acc + span) {
          const t = Math.min(1, Math.max(0, (elapsed - acc) / span))
          // 线性：这条轨道多来自逐帧采样，每段再缓一次会让转向一顿一顿。
          value = prev + (Number(entry.value) * DEG - prev) * t
          break
        }
        acc += span
        prev = Number(entry.value) * DEG
      }
      if (value === null) value = prev
      stage.vrm.scene.rotation.y = value
    } else if (stage.turn !== undefined && stage.turn !== null) {
      const turn = stage.turn
      const t = Math.min(1, Math.max(0, (performance.now() - turn.start) / turn.duration))
      const eased = t * t * (3 - 2 * t)
      stage.vrm.scene.rotation.y = turn.from + (turn.to - turn.from) * eased
      if (t >= 1) stage.turn = null
    }
    // Gravity and ground contact, with hysteresis: the body only falls while both feet are
    // clear of the floor by more than a dead zone, and only lifts when a foot has gone
    // through it. Snapping every frame at the contact line made her twitch.
    if (stage.groundLock === true) {
      ensureFloor(stage)
      const body = stage.gravity
      const root = stage.vrm.scene
      if (body.base === null) body.base = root.position.y
      // Only write the root when the change is visible: a sub-pixel write every frame makes
      // the spring bones (skirt, hair) twitch, because they react to their parent's motion.
      const wanted = body.base + body.offset
      if (Math.abs(root.position.y - wanted) > 0.05) root.position.y = wanted
      // No second vrm.update(): its spring-bone solver would step twice per frame. World
      // matrices are refreshed by the probe below, which is all the contact check needs.
      const lowest = lowestFootY(stage)
      const deadZone = 0.0015 * (Number(stage.unitsPerMetre) > 0 ? Number(stage.unitsPerMetre) : 600)
      if (lowest !== null && stage.floorY === null) {
        // The floor is exactly where her feet stood on the first frame that had a pose.
        stage.floorY = lowest
      }
      if (lowest !== null && stage.floorY !== null) {
        if (lowest < stage.floorY - deadZone) {
          root.position.y += stage.floorY - lowest
          body.offset = root.position.y - body.base
          body.velocity = 0
        } else if (lowest <= stage.floorY + deadZone) {
          body.velocity = 0
        } else if (S.dragging !== true) {
          // Airborne: integrate. Clamp dt so a backgrounded tab cannot teleport her.
          const step = Math.min(0.05, Math.max(0, delta))
          body.velocity += body.acceleration * step
          body.offset += body.velocity * step
        }
      }
    }
    renderer.render(scene, camera)
    stage.frames += 1
    if (stage.springReady !== true && stage.frames > 2) {
      // Some packs only expose their joints after the first update.
      const joints = applySpringStrength(stage)
      stage.springJoints = joints
      if (joints > 0) stage.springReady = true
    }
    // Reveal only after a frame exists, so the swap is never a blank canvas.
    if (stage.frames === 1 && stage.mask !== undefined) {
      stage.mask.remove()
      stage.mask = undefined
    }
  })

  observeVrmHost(host)
  subscribeStage()
  installPointerGestures()
  window.setTimeout(() => { verifyRender() }, 1200)
  applyDefaults(config.defaults ?? null)
  reportStatus({ draw: { stage: 'vrm', textures: 0, drew: true, channels: stage.channelCount, missing: stage.missing.slice(0, 12) } })
  window.__dshTavernLite = {
    vrm,
    renderer,
    scene,
    camera,
    config,
    stage,
  }
}

/** Keep the 3D renderer and camera matching the host box. */
function observeVrmHost(host) {
  const observer = new ResizeObserver(() => {
    if (S.vrm === null || S.primary?.host !== host) return
    const { width, height } = sizeOf(host)
    S.vrm.renderer.setSize(width, height, false)
    S.vrm.camera.left = -width / 2
    S.vrm.camera.right = width / 2
    S.vrm.camera.top = height / 2
    S.vrm.camera.bottom = -height / 2
    S.vrm.camera.updateProjectionMatrix()
    fitVrm()
  })
  observer.observe(host)
  S.observers.push(() => observer.disconnect())
}

/**
 * Scale the model to the layout height and stand it on the bottom edge.
 *
 * The camera frustum is one pixel per world unit, so the numbers here are the same
 * ones the Live2D fit uses: height ratio times viewport, then the drag offsets.
 */
function fitVrm() {
  const stage = S.vrm
  if (stage === null || stage.vrm === null) return
  const root = stage.vrm.scene
  const pivot = stage.pivot
  const ratio = Number(S.workbenchPane === null ? S.layout?.height : (S.workbenchHeight ?? S.layout?.height))
  const targetHeight = window.innerHeight * (Number.isFinite(ratio) ? ratio : 0.92)
  // The unscaled size never changes, so it is measured once instead of on every
  // frame of a drag.
  if (stage.baseSize === undefined) {
    root.scale.setScalar(1)
    root.position.set(0, 0, 0)
    root.updateMatrixWorld(true)
    const base = new THREE.Box3().setFromObject(root)
    stage.baseSize = base.getSize(new THREE.Vector3())
    stage.baseBottom = base.min.y
  }
  const capRatio = Number(S.config?.widthCap)
  const maxWidth = window.innerWidth * (Number.isFinite(capRatio) ? Math.min(1, Math.max(0.2, capRatio)) : 0.6)
  // A model whose bounds collapse to nothing (an empty first frame) must not be
  // scaled by a number near zero, or she fills the screen.
  const baseHeight = stage.baseSize.y > 0.01 ? stage.baseSize.y : 1.6
  const baseWidth = stage.baseSize.x > 0.01 ? stage.baseSize.x : 1.0
  const scale = Math.min(
    targetHeight / baseHeight,
    maxWidth / baseWidth,
  )
  if (!(scale > 0) || !Number.isFinite(scale)) return
  if (stage.appliedScale !== scale) {
    root.scale.setScalar(scale)
    stage.appliedScale = scale
    // The standing reference must be in the same units the checks use, and it must be
    // captured while the rig is actually standing: grabbing it in the middle of an
    // animation records a bent pose as "rest", which makes every height check meaningless.
    const idle = stage.hipsTrack === null || stage.hipsTrack === undefined
    if (idle || stage.restFrame === undefined || stage.restFrame === null) {
      const rest = readPoseSkeleton(stage.vrm, scale)
      if (rest !== null) stage.restFrame = { headY: rest.head.y, footY: rest.leftFoot.y }
    }
  }
  stage.drawn = {
    widthPx: Math.round(baseWidth * scale),
    heightPx: Math.round(baseHeight * scale),
    capPx: Math.round(maxWidth),
  }
  const { height } = stage.renderer.getSize(new THREE.Vector2())
  // Feet on the bottom edge: the model's own bottom sits at -height/2 in world units.
  const bottomY = stage.baseBottom * scale
  root.position.set(0, -height / 2 - bottomY, 0)
  root.updateMatrixWorld(true)
  // Drag offsets live on the pivot. Screen-down is world-down here, so the vertical
  // offset is negated; applying it with the screen's sign is what made dragging feel
  // inverted, and moving it off the model removed the diagonal shear.
  const shift = S.workbenchPane === null ? { x: 0, y: 0 } : S.workbenchOffset
  pivot.position.set(
    (S.layout?.model?.x ?? 0) + shift.x,
    -((S.layout?.model?.y ?? 0) + shift.y),
    0,
  )
  // The floor belongs to the stage, not to the world: dragging moves the avatar and her
  // floor together. A world-fixed floor would turn every upward drag into a fall, because
  // the feet would read as "above the ground" and gravity would pull her back down.
  if (stage.gravity !== undefined && stage.gravity !== null) {
    stage.gravity.base = pivot.position.y + root.position.y
    stage.gravity.offset = 0
    stage.gravity.velocity = 0
  }
  if (stage.floor !== undefined && stage.gravity !== undefined && stage.gravity !== null) {
    // Re-derive the floor from the feet on the next frame instead of trusting the old
    // bounding-box bottom, which drifts with the pose.
    stage.floorY = null
  }
  pivot.updateMatrixWorld(true)
}

/** The character's rectangle on screen, in CSS pixels. */
function vrmScreenRect() {
  const stage = S.vrm
  if (stage === null || stage.vrm === null) return undefined
  try {
    // `setFromObject` measures in world space, so the pivot's drag offset is already
    // part of the box: adding it again would put the hit area a second offset away
    // from the character after any drag.
    const box = new THREE.Box3().setFromObject(stage.vrm.scene)
    const size = box.getSize(new THREE.Vector3())
    const rect = stage.canvas.getBoundingClientRect()
    const factor = Number(S.config?.hitBoxScale)
    const reach = Number.isFinite(factor) ? Math.min(2, Math.max(0.2, factor)) : 1
    // The camera frustum is one pixel per world unit and centred, so world
    // coordinates map straight onto the canvas.
    const centerX = (box.min.x + box.max.x) / 2
    const bottomY = box.min.y
    const width = size.x * reach
    const height = size.y * reach
    if (!(width > 2) || !(height > 2)) return undefined
    return {
      left: rect.left + rect.width / 2 + centerX - width / 2,
      top: rect.top + rect.height / 2 - bottomY - height,
      width,
      height,
    }
  } catch {
    return undefined
  }
}

/** Read the frame's emotion and aim the expression weights at it. */
/** Pose payload of a frame, or null when the frame only changes the expression. */
function vrmPoseOf(frame) {
  const params = frame.params !== null && typeof frame.params === 'object' ? frame.params : {}
  const pinned = new Map()
  const expressions = new Map()
  for (const [id, raw] of Object.entries(params)) {
    const value = Number(raw)
    if (!Number.isFinite(value)) continue
    // `Expr:<name>` writes a face expression, which a bone channel cannot do: a closed eye is a
    // blink expression, not a rotation.
    if (id.startsWith('Expr:')) {
      const name = id.slice(5).trim()
      if (name !== '') expressions.set(name, Math.min(1, Math.max(0, value)))
      continue
    }
    if (!S.vrm?.bones.has(id)) continue
    pinned.set(id, value)
  }
  const animation = typeof frame.animation === 'string' && frame.animation !== '' ? frame.animation : ''
  const translate = frame.translate !== null && typeof frame.translate === 'object' ? frame.translate : null
  if (pinned.size === 0 && expressions.size === 0 && animation === '' && translate === null) return null
  return { pinned, expressions, animation, translate }
}

/** Put one pose on the bones. */
function showVrmPose(pose) {
  const stage = S.vrm
  if (stage === null) return
  stage.translate = pose.translate
  stage.pinned = pose.pinned
  const pinnedExpressions = pose.expressions ?? new Map()
  for (const name of stage.exprPinned.keys()) {
    if (!pinnedExpressions.has(name)) stage.target.delete(name)
  }
  for (const [name, value] of pinnedExpressions) stage.target.set(name, value)
  stage.exprPinned = new Map(pinnedExpressions)
  if (pose.animation !== '') startVrmTracks(pose.animation)
}

/**
 * Show a pose on the bones.
 *
 * Frames are applied as they arrive: holding one back on a timer made a second action in the
 * same turn look like it never happened.
 *
 * @param pose - Parsed pose, or null when the frame only changes the expression.
 */
function applyVrmPose(pose) {
  if (pose === null) return
  showVrmPose(pose)
}

/** Read the frame's emotion and aim the expression weights at it. */
/**
 * Measure the pose against the recipe's geometric checks and report the result.
 *
 * The Host cannot see the skeleton; the browser is the only place a distance can be measured,
 * so the verdict is pushed back over HTTP for `live2d_check` to read.
 */
function reportVrmChecks(frame) {
  const stage = S.vrm
  if (stage === null || !Array.isArray(frame?.checks) || frame.checks.length === 0) return
  const results = evaluateChecks(stage.vrm, frame.checks, stage.restFrame, stage.appliedScale ?? 1)
  if (results.length === 0) return
  stage.lastChecks = { recipe: frame.recipe ?? null, results, at: Date.now() }
  const failed = results.filter(entry => entry.ok !== true).length
  void fetchJson(`${API}/checks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ recipe: frame.recipe ?? null, results }),
  }).catch(() => {})
  if (failed > 0) console.info('[dsh-live-tavern-lite] pose checks failed', results)
  return { failed, total: results.length }
}

function applyVrmFrame(frame) {
  const stage = S.vrm
  if (stage === null) return
  const weights = VRM_EMOTIONS[frame.emotion] ?? VRM_EMOTIONS.neutral
  const intensity = Number.isFinite(Number(frame.intensity)) ? Number(frame.intensity) : 0.6
  stage.target = new Map(Object.entries(weights).map(([name, value]) => [name, value * intensity]))
  // Channels, not curves: a frame may pin a bone outright (presets and recipes do this).
  applyVrmPose(vrmPoseOf(frame))
  // Checks run after the easing has settled, not on the next frame.
  if (Array.isArray(frame.checks) && frame.checks.length > 0) {
    stage.pendingChecks = { checks: frame.checks, recipe: frame.recipe ?? null, due: performance.now() + 900 }
  }
}

/** Ids that move the whole body instead of a bone; values are metres, negative is down. */
const HIPS_TRACK_IDS = new Set(['HipsY', 'HipsMoveY'])

/**
 * Ids that slide the whole body across the stage, in metres.
 *
 * Turns needed a root yaw; walking needs a root offset. Bone rotations cannot produce either,
 * which is why a dance transcribed only from limb angles never leaves its spot.
 */
const MOVE_TRACK_IDS = new Set(['MoveX', 'MoveZ'])

/** Start bone tracks from an `animation` string. */
function startVrmTracks(text) {
  const stage = S.vrm
  if (stage === null) return
  const entries = parseTracks(text)
  // `TurnY=<deg>@ms` yaws the whole body. None of the 153 bone channels can do it: the
  // hips' Y axis is a dead twist, so facing has to be a rotation of the model root.
  const turn = entries.find(entry => entry.id === 'TurnY')
  if (turn !== undefined) {
    const root = stage.vrm.scene
    const from = Number(root.rotation.y) || 0
    const turnEntries = entries.filter(entry => entry.id === 'TurnY')
    if (turnEntries.length > 1) {
      // 多关键帧的 TurnY 是一条真正的轨道：逐帧插值，才能转过去再转回来。
      // 只取第一条会把它当成一次性缓动，整段只剩起手朝向。
      stage.turn = null
      stage.turnTrack = { from, entries: turnEntries, start: performance.now() }
    } else {
      stage.turnTrack = null
      const to = Number(turn.value) * DEG
      stage.turn = { from, to, start: performance.now(), duration: Math.max(60, Number(turn.ms) || 400) }
    }
  }
  // `JumpV=<m/s>@ms` is an impulse, not a pose: it seeds the vertical velocity gravity then
  // integrates. Without it a pose cannot leave the floor — raising the hips raises the feet
  // with them, and ground contact pulls the body straight back down.
  const jump = entries.find(entry => entry.id === 'JumpV')
  if (jump !== undefined && stage.gravity !== undefined && stage.gravity !== null) {
    const units = Number(stage.unitsPerMetre) > 0 ? Number(stage.unitsPerMetre) : 600
    const speed = Math.max(0, Number(jump.value) || 0) * units
    if (speed > 0) stage.gravity.velocity = speed
  }
  const hipsEntries = entries.filter(entry => HIPS_TRACK_IDS.has(entry.id))
  if (hipsEntries.length > 0) {
    const [channel] = startTracks(hipsEntries, () => 0, performance.now())
    stage.hipsTrack = channel ?? null
  } else {
    // A pose without a body track returns the body to its rest height.
    stage.hipsTrack = null
    stage.hipsAnimatedY = 0
  }
  const moveEntries = entries.filter(entry => MOVE_TRACK_IDS.has(entry.id))
  if (moveEntries.length > 0) {
    const [channel] = startTracks(moveEntries, () => 0, performance.now())
    stage.moveTrack = channel ?? null
  } else {
    stage.moveTrack = null
    stage.moveX = 0
    stage.moveZ = 0
  }
  const parsed = entries.filter(entry => stage.bones.has(entry.id))
  if (parsed.length === 0) return
  const read = (id) => {
    const bone = stage.bones.get(id)
    return bone === undefined ? 0 : bone.node.rotation[bone.axis] / DEG
  }
  const fresh = startTracks(parsed, read, performance.now())
  const ids = new Set(fresh.map(channel => channel.id))
  stage.tracks = stage.tracks.filter(channel => !ids.has(channel.id)).concat(fresh)
}

/** Advance bone tracks and write the rotations. */
function stepVrmTracks(now) {
  const stage = S.vrm
  if (stage === null || stage.tracks.length === 0) return
  const { values, active } = stepTracks(stage.tracks, now)
  for (const [id, channel] of values) {
    const bone = stage.bones.get(id)
    if (bone === undefined) continue
    const degrees = channel.mode === 'add' ? (stage.pinned.get(id) ?? 0) + channel.value : channel.value
    bone.node.rotation[bone.axis] = bone.rest + degrees * DEG
  }
  if (!active) stage.tracks = []
}

/** Ease every expression toward its aim, and blink on a timer. */
function easeVrmExpressions(delta) {
  const stage = S.vrm
  const manager = stage?.vrm?.expressionManager
  if (manager === undefined || manager === null) return
  const names = new Set([...stage.target.keys(), ...stage.current.keys(), 'blink'])
  for (const name of names) {
    const aim = stage.target.get(name) ?? 0
    const now = stage.current.get(name) ?? 0
    const next = now + (aim - now) * Math.min(1, delta * 8)
    stage.current.set(name, next)
    try {
      manager.setValue(name, Math.min(1, Math.max(0, next)))
    } catch {
      // A model without that expression is not an error.
    }
  }
  // A slow blink stands in for the engine's eye-blink, which a VRM does not have.
  const nowMs = performance.now()
  if (nowMs >= stage.nextBlink) {
    stage.blinkAt = nowMs
    stage.nextBlink = nowMs + 2600 + Math.random() * 2600
  }
  const blinking = nowMs - stage.blinkAt < 120
  try {
    manager.setValue('blink', blinking ? 1 : (stage.target.get('blink') ?? 0))
  } catch {
    // Same rule.
  }
}

/** Tear the 3D stage down. */
function disposeVrm() {
  const stage = S.vrm
  if (stage === null) return
  cancelAnimationFrame(stage.raf)
  try {
    stage.renderer.dispose()
    stage.canvas.remove()
  } catch {
    // Disposal is best-effort.
  }
  S.vrm = null
}

/** Pixel size of a host box, never zero (pixi rejects an empty framebuffer). */
function sizeOf(node) {
  const rect = node.getBoundingClientRect()
  return { width: Math.max(1, Math.round(rect.width)), height: Math.max(1, Math.round(rect.height)) }
}

/** Keep the renderer matching the primary host box. */
function observeHost(host) {
  const observer = new ResizeObserver(() => {
    if (!S.app || S.primary?.host !== host) return
    const { width, height } = sizeOf(host)
    S.app.renderer.resize(width, height)
    fitModel()
  })
  observer.observe(host)
  S.observers.push(() => observer.disconnect())
}

async function startEngine() {
  // A mounted stage is either the pixi app or the 3D one; both must block a remount.
  if (S.starting || S.app !== null || S.vrm !== null) return
  S.starting = true
  try {
    await startEngineInner()
  } finally {
    S.starting = false
  }
}

/**
 * Leave the page untouched when no model is configured.
 *
 * The stage owns a mask, seats and a canvas; with no pack selected there is nothing to draw, so
 * this hides what a previous activation may have left behind and installs nothing.
 */
function stageIdle() {
  S.idle = true
  for (const entry of S.seats.values()) {
    if (entry?.node !== undefined) {
      entry.node.hidden = true
      entry.node.remove()
    }
  }
  S.seats.clear()
  if (S.primary?.host !== undefined) {
    S.primary.host.hidden = true
    S.primary.host.remove()
  }
  S.primary = null
  if (S.mask !== undefined) {
    S.mask.remove()
    S.mask = undefined
  }
}

async function startEngineInner() {
  const config = S.config
  if (!config.selected) {
    // An empty pack path means no model configured: the plugin stays out of the page instead of
    // painting an error over a UI the player did not ask for a character for.
    stageIdle()
    return
  }
  if (config.stageKind === 'vrm') {
    // The Host drops VRM packs where the 3D stage cannot run (Android); a stale page that still
    // carries one says why instead of trying to build a WebGL scene that will not work.
    if (config.vrmSupported === false) {
      showError(new Error('当前环境不支持 VRM 舞台（安卓端只跑 Live2D）。换一个 Live2D 角色包，或到桌面端使用 3D 模型。'))
      return
    }
    await startVrmEngine(config)
    return
  }
  if (typeof window.Live2DCubismCore === 'undefined') {
    throw new Error('Cubism 运行时未加载：客户端产物里没有内联 live2dcubismcore。')
  }
  extensions.add(Live2DPlugin)
  try {
    configureCubismSDK({ memorySizeMB: 64 })
  } catch (error) {
    // An older runtime may reject the option; the default 16 MB still loads one model.
    console.warn('[dsh-live-tavern] configureCubismSDK ignored', error)
  }

  // A client plugin activates before the React shell mounts, so the conversation
  // column may not exist yet. Wait for it, then degrade to the frame overlay —
  // which always has a body anchor — instead of failing the whole stage.
  const available = await waitForSeats(config.placement)
  if (available.length === 0) {
    S.degraded = true
    config.placement = ['foreground']
    console.warn('[dsh-live-tavern] 聊天列/侧栏锚点迟迟没有出现，已退到前景浮层')
  } else {
    config.placement = available
  }

  const primaryPlacement = config.placement[0] ?? 'foreground'
  const seat = ensureSeat(primaryPlacement)
  if (seat === null) {
    showError(new Error(`舞台坐席 '${primaryPlacement}' 在页面里没有找到锚点元素。`))
    return
  }
  const host = mountCanvasHost(seat, primaryPlacement)
  S.primary = { placement: primaryPlacement, host }

  const mask = el('div', { class: 'dsh-l2d-mask', text: `载入 ${config.selected.id} …` })
  seat.append(mask)

  const box = sizeOf(host)
  const app = new Application()
  await app.init({
    preference: 'webgl',
    backgroundAlpha: 0,
    antialias: true,
    autoDensity: true,
    resolution: Math.min(window.devicePixelRatio || 1, 2),
    width: box.width,
    height: box.height,
  })
  S.app = app
  host.append(app.canvas)
  observeHost(host)
  // A desktop companion does not need 60 fps, and a hidden tab needs none.
  if (typeof app.ticker === 'object' && app.ticker !== null) {
    app.ticker.maxFPS = 30
    const onVisibility = () => {
      if (document.hidden) app.ticker.stop()
      else app.ticker.start()
    }
    document.addEventListener('visibilitychange', onVisibility)
    S.observers.push(() => {
      document.removeEventListener('visibilitychange', onVisibility)
    })
  }

  // The engine reports its failures through console warnings; keep them so the
  // diagnostics can carry the real reason instead of a guess.
  S.engineLog = []
  const originalWarn = console.warn
  const originalError = console.error
  const capture = (level) => (...args) => {
    try {
      if (S.engineLog.length < 20) S.engineLog.push(`${level}: ${args.map(item => String(item)).join(' ').slice(0, 200)}`)
    } catch {
      // Capturing must never break the call it observes.
    }
    ;(level === 'warn' ? originalWarn : originalError).apply(console, args)
  }
  console.warn = capture('warn')
  console.error = capture('error')
  let model
  try {
    model = await Live2DModel.from(config.selected.entryUrl, {
      textureOptions: { lod: config.textureLod },
      // Pointer tracking is off by default: the engine adds its focus offsets to the
      // head and eye parameters before the rig writes them, which made a head turn
      // from the model fight a camera it never asked for.
      autoFocus: config.lookAtPointer === true,
      autoHitTest: false,
    })
  } finally {
    console.warn = originalWarn
    console.error = originalError
  }
  S.model = model
  S.modelLoadedAt = performance.now()
  S.visibleRel = undefined
  S.visibleSignature = undefined
  app.stage.addChild(model)
  // Measure before the first fit: the artwork's real extent decides the size, and a
  // wide canvas with big margins must not be scaled as if it were a tall portrait.
  measureVisible()
  fitModel()
  mask.remove()
  applyPlacements(config.placement)
  subscribeStage()
  installRig()
  installPointerGestures()
  applyDefaults(S.config?.defaults ?? null)
  // One deliberate check beats guessing: a blank canvas with a working bubble has
  // no other symptom.
  window.setTimeout(() => { verifyRender() }, 1200)
  window.__dshTavernLite = {
    model,
    app,
    config,
    // The rectangle a tap or drag has to land in; readable without the DOM.
    dragArea: () => ({
      hit: modelScreenRect() ?? null,
      canvas: S.app === null ? null : (() => {
        const canvasRect = S.app.canvas.getBoundingClientRect()
        return { x: Math.round(canvasRect.x), y: Math.round(canvasRect.y), width: Math.round(canvasRect.width), height: Math.round(canvasRect.height) }
      })(),
    }),
    state: S,
    placements: (list) => { applyPlacements(list); renderPanel() },
  }
  reportStatus({ ok: true })
}

/**
 * Move the single WebGL canvas into the winning seat and mirror it into the
 * seats that do not overlap it.
 *
 * Two seats with the same screen area would draw the same model twice, one frame
 * apart, which reads as flicker. So the topmost selected seat owns the canvas,
 * the frame overlay wins over anything it covers, and only genuinely separate
 * seats (chat column vs sidebar) get a mirror.
 */
function applyPlacements(list) {
  // The 3D stage has no mirrors, but it does need the workbench pane: lending the
  // canvas to it is what lets the art and the sliders share one screen.
  if (S.kind === 'vrm' && S.vrm !== null && S.primary !== null) {
    const wanted = [].concat(list)
    const pane = S.workbenchPane !== null && S.workbenchPane.isConnected ? S.workbenchPane : null
    const target = pane ?? ensureSeat(wanted[0] ?? 'foreground') ?? ensureSeat('foreground')
    if (target === null) return
    const host = S.primary.host
    if (!target.contains(host)) target.append(host)
    host.dataset.placement = pane === null ? (wanted[0] ?? 'foreground') : 'workbench'
    S.primary = { placement: pane === null ? (wanted[0] ?? 'foreground') : 'workbench', host }
    const box = sizeOf(target)
    S.vrm.renderer.setSize(box.width, box.height, false)
    S.vrm.camera.left = -box.width / 2
    S.vrm.camera.right = box.width / 2
    S.vrm.camera.top = box.height / 2
    S.vrm.camera.bottom = -box.height / 2
    S.vrm.camera.updateProjectionMatrix()
    fitVrm()
    return
  }
  if (!S.app || S.primary === null) return
  // The parameter workbench lends the stage a temporary seat: the canvas moves
  // into its right pane, so the art and the sliders share one screen and one
  // WebGL context — nothing is loaded twice.
  if (S.workbenchPane !== null && S.workbenchPane.isConnected) {
    const host = S.primary.host
    if (!S.workbenchPane.contains(host)) S.workbenchPane.append(host)
    host.dataset.placement = 'workbench'
    S.primary = { placement: 'workbench', host }
    for (const mirror of [...S.mirrors]) {
      mirror.host.remove()
      S.mirrors.delete(mirror)
    }
    const box = sizeOf(S.workbenchPane)
    S.app.renderer.resize(box.width, box.height)
    fitModel()
    if (S.frame === 0) S.frame = requestAnimationFrame(mirrorFrame)
    return
  }
  const wanted = [...new Set(SEATS.filter(seat => [].concat(list).includes(seat)))]
  if (wanted.length === 0) wanted.push('chat')
  const primary = wanted.includes('foreground') ? 'foreground' : wanted[wanted.length - 1]
  const mirrored = wanted.filter(seat => seat !== primary && seat !== 'foreground' && primary !== 'foreground')
  S.config.placement = [primary, ...mirrored]
  const primarySeat = ensureSeat(primary)
  if (primarySeat === null) {
    showError(new Error(`坐席 '${primary}' 在页面里没有找到锚点元素。`))
    return
  }
  const host = S.primary.host
  if (!primarySeat.contains(host)) primarySeat.append(host)
  host.dataset.placement = primary
  S.primary = { placement: primary, host }
  const box = sizeOf(host)
  S.app.renderer.resize(box.width, box.height)
  fitModel()

  for (const mirror of [...S.mirrors]) {
    mirror.host.remove()
    S.mirrors.delete(mirror)
  }
  for (const placement of mirrored) {
    const seat = ensureSeat(placement)
    if (seat === null) continue
    const mirrorHost = mountCanvasHost(seat, placement)
    const canvas = el('canvas', { class: 'dsh-l2d-mirror' })
    const context = canvas.getContext('2d')
    if (context === null) {
      mirrorHost.remove()
      continue
    }
    mirrorHost.append(canvas)
    S.mirrors.add({ placement, canvas, context, host: mirrorHost })
  }
  if (S.frame === 0) S.frame = requestAnimationFrame(mirrorFrame)
}

let lastMirrorAt = 0
function mirrorFrame(now) {
  if (S.disposed) return
  S.frame = requestAnimationFrame(mirrorFrame)
  if (S.mirrors.size === 0 || S.app === null) return
  if (now - lastMirrorAt < 33) return
  lastMirrorAt = now
  const source = S.app.canvas
  for (const mirror of S.mirrors) {
    const { width, height } = mirror.host.getBoundingClientRect()
    const scale = Math.min(window.devicePixelRatio || 1, 2)
    const targetWidth = Math.max(1, Math.round(width * scale))
    const targetHeight = Math.max(1, Math.round(height * scale))
    if (mirror.canvas.width !== targetWidth || mirror.canvas.height !== targetHeight) {
      mirror.canvas.width = targetWidth
      mirror.canvas.height = targetHeight
    }
    mirror.context.clearRect(0, 0, targetWidth, targetHeight)
    mirror.context.drawImage(source, 0, 0, targetWidth, targetHeight)
  }
}

/** Report what this page actually saw, so the Host side can be verified without a console. */
function reportStatus(extra) {
  const body = {
    coreLoaded: typeof window.Live2DCubismCore !== 'undefined',
    model: S.config?.selected?.id ?? null,
    placement: S.config?.placement ?? null,
    seats: [...S.seats.entries()].filter(([, entry]) => !entry.marker).map(([name, entry]) => ({
      name,
      connected: entry.node.isConnected,
      width: Math.round(entry.node.getBoundingClientRect().width),
      height: Math.round(entry.node.getBoundingClientRect().height),
    })),
    canvas: S.app ? { width: S.app.screen.width, height: S.app.screen.height } : null,
    // Enough state to tell "not visible" apart from "not loaded" without a console.
    render: S.app === null ? null : {
      stageChildren: S.app.stage.children.length,
      tickerRunning: S.app.ticker?.started !== false,
      alpha: S.model?.alpha ?? null,
      visible: S.model?.visible ?? null,
      scaleY: S.model?.scale?.y ?? null,
      drawn: S.vrm?.drawn ?? null,
      materialsFixed: S.vrm?.materialsFixed ?? null,
      outlinesRemoved: S.vrm?.outlinesRemoved ?? null,
      springJoints: S.vrm?.springJoints ?? null,
      channels: S.vrm?.channelCount ?? null,
      position: S.model ? { x: Math.round(S.model.x), y: Math.round(S.model.y) } : null,
      canvasRect: (() => {
        const rect = S.app.canvas.getBoundingClientRect()
        return { left: Math.round(rect.left), top: Math.round(rect.top), width: Math.round(rect.width), height: Math.round(rect.height) }
      })(),
    },
    layout: S.layout ? { height: S.layout.height, model: S.layout.model } : null,
    draw: S.renderReport ?? null,
    expressions: S.config?.selected?.expressions ?? [],
    panel: S.panel !== null,
    href: location.pathname + location.search,
    ...extra,
  }
  fetch(`${API}/status`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }).then((response) => {
    if (response.ok) return undefined
    // Older Host builds have no status route; fall back to the binding route so
    // the report still reaches a readable place on disk.
    return fetch(`${API}/binding?model=__live2d_selftest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expressions: { __diag: body } }),
    })
  }).catch(() => { /* diagnostics must never break the stage */ })
}

/**
 * Show one line of dialogue above the character.
 *
 * The bubble lives on `document.body`, not inside the seat: the chat seat paints
 * at z-index -1 (behind the transcript), so a bubble there would be invisible.
 */
/** Place the bubble over the character's head, offset by the layout sliders. */
function positionBubble() {
  if (S.bubble === null) return
  // Anchored to the model's own bounds, not to the seat: the seat is the whole
  // column, so anchoring there left the bubble behind whenever she moved.
  let anchorX = window.innerWidth / 2
  let anchorTop = window.innerHeight * 0.4
  if (S.kind === 'vrm' && S.vrm !== null) {
    const rect = vrmScreenRect()
    if (rect !== undefined) {
      anchorX = rect.left + rect.width / 2
      anchorTop = rect.top
    }
  } else if (S.model !== null && S.app !== null) {
    try {
      const rect = S.app.canvas.getBoundingClientRect()
      const bounds = S.model.getBounds()
      anchorX = rect.left + bounds.x + bounds.width / 2
      anchorTop = rect.top + bounds.y
    } catch {
      // Keep the viewport fallback while the model has no measurable bounds.
    }
  } else if (S.primary?.host) {
    const rect = S.primary.host.getBoundingClientRect()
    anchorX = rect.left + rect.width / 2
    anchorTop = rect.top + rect.height * 0.4
  }
  const gap = 10
  S.bubble.style.left = `${Math.round(anchorX + S.layout.bubble.x)}px`
  S.bubble.style.bottom = `${Math.max(8, Math.round(window.innerHeight - anchorTop + gap - S.layout.bubble.y))}px`
}

function showBubble(line) {
  if (S.bubble === null || !S.bubble.isConnected) {
    S.bubble = el('div', { class: 'dsh-l2d-bubble' })
    document.body.append(S.bubble)
  }
  positionBubble()
  S.bubble.textContent = line
  S.bubble.dataset.placeholder = '0'
  S.bubble.dataset.show = '1'
}

function hideBubble() {
  // The settings preview must survive the auto-hide timer, otherwise the bubble
  // disappears while the sliders are still being dragged.
  if (S.bubble === null || S.bubble.dataset.preview === '1') return
  S.bubble.dataset.show = '0'
}

const BUBBLE_PREVIEW_TEXT = '气泡位置预览'

/** Show (or release) a placeholder bubble while the position sliders are open. */
function previewBubble(on) {
  if (on) {
    if (S.bubble === null || !S.bubble.isConnected) {
      S.bubble = el('div', { class: 'dsh-l2d-bubble' })
      document.body.append(S.bubble)
    }
    if (S.bubble.dataset.preview !== '1') {
      S.bubble.dataset.preview = '1'
      // A real line keeps its text; only an empty bubble gets the placeholder.
      if (S.bubble.textContent === '') {
        S.bubble.textContent = BUBBLE_PREVIEW_TEXT
        S.bubble.dataset.placeholder = '1'
      }
    }
    positionBubble()
    S.bubble.dataset.show = '1'
    return
  }
  if (S.bubble === null) return
  S.bubble.dataset.preview = '0'
  if (S.bubble.dataset.placeholder === '1') {
    S.bubble.dataset.placeholder = '0'
    S.bubble.textContent = ''
    S.bubble.dataset.show = '0'
  }
}

/**
 * Apply one stage directive: expression, motion, and the optional spoken line.
 *
 * The Host resolves the emotion into a model-bound expression, so this side
 * only applies what the Host already decided. After `holdMs` with no new
 * directive the face returns to its resting expression.
 */
/**
 * Clear the current expression.
 *
 * `model.expression()` with no argument picks a RANDOM expression, so it must
 * never be used as a reset — that silently swapped the artist's face in instead
 * of returning to the plain one.
 */
function resetFace() {
  const manager = S.model?.internalModel?.motionManager?.expressionManager
  if (!manager || typeof manager.resetExpression !== 'function') return
  try {
    manager.resetExpression()
  } catch {
    // A model without expressions has nothing to reset.
  }
}

function applyStage(frame) {
  if (frame === null || typeof frame !== 'object') return
  S.lastStage = frame
  if (S.kind === 'vrm') applyVrmFrame(frame)
  if (S.kind !== 'vrm' && typeof frame.expression === 'string' && S.model) {
    S.model.expression(frame.expression).catch(error => console.warn('[dsh-live-tavern] expression failed', error))
  } else {
    resetFace()
  }
  if (S.kind !== 'vrm' && frame.motion && S.model) {
    S.model.motion(frame.motion.group, frame.motion.index, 3).catch(() => { /* a missing motion is not an error */ })
  }
  if (S.kind !== 'vrm' && typeof frame.rigVersion === 'number' && frame.rigVersion !== S.rigStamp) {
    void refreshRig(frame.rigVersion)
  }
  const easeMs = Number(frame.easeMs)
  S.easeFactor = Number.isFinite(easeMs)
    ? Math.min(1, Math.max(0.02, 16.7 / easeMs))
    : 0.2
  if (S.kind !== 'vrm' && frame.params !== null && typeof frame.params === 'object') {
    if (!(S.extra instanceof Map)) S.extra = new Map()
    const seen = new Set()
    const rigEntries = S.rig === null ? [] : S.rig.entries
    for (const entry of rigEntries) {
      const value = Number(frame.params[entry.id])
      if (!Number.isFinite(value)) continue
      entry.target = Math.min(entry.max, Math.max(entry.min, value))
      seen.add(entry.id)
    }
    // A preset pins parameters the rig may never mention; they are written by the
    // same per-frame loop, so a pose does not need the rig table to include it.
    for (const [id, raw] of Object.entries(frame.params)) {
      if (seen.has(id)) continue
      const value = Number(raw)
      if (!Number.isFinite(value)) continue
      const current = S.extra.get(id)
      S.extra.set(id, { target: value, current: current === undefined ? value : current.current })
    }
    for (const id of [...S.extra.keys()]) {
      if (!(id in frame.params)) S.extra.delete(id)
    }
  }
  if (typeof frame.animation === 'string' && frame.animation !== '') startAnimation(frame.animation)
  if (typeof frame.line === 'string' && frame.line !== '') showBubble(frame.line)
  if (S.revertTimer !== 0) clearTimeout(S.revertTimer)
  const hold = Number(frame.holdMs) > 0 ? Number(frame.holdMs) : 9000
  S.revertTimer = window.setTimeout(() => {
    S.revertTimer = 0
    hideBubble()
    if (S.rig !== null) {
      for (const entry of S.rig.entries) entry.target = entry.base
    }
    resetFace()
    }, hold)
}

/** Never let a stage event start a second connection. */
function subscribeStage() {
  if (S.stageSource !== null) return
  const source = new EventSource(`${API}/stage`)
  source.addEventListener('stage', (event) => {
    try {
      applyStage(JSON.parse(event.data))
    } catch (error) {
      console.warn('[dsh-live-tavern] bad stage frame', error)
    }
  })
  source.addEventListener('open', () => {
    console.info('[dsh-live-tavern] stage stream open')
  })
  S.stageSource = source
}

/**
 * Turn a reply's track line into a running animation.
 *
 * The starting value is read from the live rig, so a track layers over whatever
 * emotion is showing instead of resetting the face. A new track for the same
 * parameter replaces the old one rather than fighting it.
 *
 * @param text - The `animation` field of a frame.
 * @returns The number of tracks started.
 */
function startAnimation(text) {
  const parsed = parseTracks(text)
  if (parsed.length === 0) return 0
  const read = (id) => {
    const entry = S.rig?.entries.find(item => item.id === id)
    if (entry !== undefined) return entry.current
    try {
      const handle = S.rig === null ? id : S.rig.handleFor(id)
      const value = Number(S.model?.internalModel?.coreModel?.getParameterValueById?.(handle))
      return Number.isFinite(value) ? value : 0
    } catch {
      return 0
    }
  }
  const fresh = startTracks(parsed, read, performance.now())
  const ids = new Set(fresh.map(track => track.id))
  S.tracks = S.tracks.filter(track => !ids.has(track.id)).concat(fresh)
  return fresh.length
}

/**
 * Where the tracks write their values: the same core model the rig drives.
 *
 * A `set` channel writes its value; an `add` channel reads what the engine or the
 * rig just produced this frame and writes that plus the offset. The engine saves
 * the parameter block before `beforeModelUpdate` and restores it afterwards, so a
 * write here never accumulates from frame to frame — an offset rides on the
 * breathing and the weight shift without destroying them.
 */
function stepAnimation(core, handleFor) {
  if (S.tracks.length === 0) return
  const { values, active } = stepTracks(S.tracks, performance.now())
  for (const [id, channel] of values) {
    try {
      const handle = handleFor(id)
      if (channel.mode === 'add') {
        const base = Number(core.getParameterValueById?.(handle))
        core.setParameterValueById(handle, (Number.isFinite(base) ? base : 0) + channel.value)
      } else {
        core.setParameterValueById(handle, channel.value)
      }
    } catch {
      // A parameter the model does not declare never breaks a frame.
    }
  }
  if (active) return
  // Land: a set channel hands its final value to the rig so nothing snaps back.
  // An additive channel simply stops writing, which restores the model's own value.
  for (const channel of S.tracks) {
    if (channel.mode === 'add') continue
    const entry = S.rig?.entries.find(item => item.id === channel.id)
    if (entry === undefined) continue
    const last = channel.segments[channel.segments.length - 1]
    const clamped = Math.min(entry.max, Math.max(entry.min, last.to))
    entry.current = clamped
    entry.target = clamped
  }
  S.tracks = []
}

/**
 * Drive the model's facial and pose parameters from the emotion vector.
 *
 * The Host resolves the vector into targets; this half eases each parameter
 * toward its target inside `beforeModelUpdate`, so a new emotion blends instead
 * of snapping, and physics still sees the changed inputs in the same frame.
 */
function installRig() {
  removeRig()
  const params = S.config?.rig?.params
  if (!Array.isArray(params) || params.length === 0 || !S.model) return
  const internal = S.model.internalModel
  if (!internal || !internal.coreModel) return
  const core = internal.coreModel
  const handleFor = (id) => (typeof internal.getIdSafe === 'function' ? internal.getIdSafe(id) : id)
  const entries = params.map(entry => ({
    id: entry.id,
    base: Number(entry.base) || 0,
    min: Number.isFinite(entry.min) ? entry.min : -1,
    max: Number.isFinite(entry.max) ? entry.max : 1,
    handle: handleFor(entry.id),
    current: Number(entry.base) || 0,
    target: Number(entry.base) || 0,
  }))
  const probe = new Map()
  const apply = () => {
    for (const entry of entries) {
      // 0.2 per frame at 60 fps settles in roughly 150 ms.
      entry.current += (entry.target - entry.current) * S.easeFactor
      try {
        core.setParameterValueById(entry.handle, entry.current)
      } catch {
        // A parameter id the model does not declare must never break a frame.
      }
    }
    // A preset pins parameters the rig table need not mention at all.
    if (!(S.extra instanceof Map)) S.extra = new Map()
    for (const [id, slot] of S.extra) {
      slot.current += (slot.target - slot.current) * S.easeFactor
      try {
        core.setParameterValueById(handleFor(id), slot.current)
      } catch {
        // Same rule as above: an unknown id never breaks a frame.
      }
    }
    // Workbench sliders write here so the per-frame parameter reset cannot drop
    // a value the user is holding.
    for (const [handle, value] of probe) {
      try {
        core.setParameterValueById(handle, value)
      } catch {
        // Same rule: an unknown id never breaks a frame.
      }
    }
    // A track owns its parameter for its duration: written last, so it wins over
    // the eased rig value in this same frame.
    stepAnimation(core, handleFor)
  }
  internal.on('beforeModelUpdate', apply)
  S.rig = { entries, apply, core, handleFor, probe }
  S.rigStamp = Number(S.config?.rig?.stamp) || 0
}

/**
 * Reload the rig table after the Host reports a new one.
 *
 * Tuning a weight on the Host no longer needs a restart, but the browser holds
 * its own copy of the table; the frame's `rigVersion` is the cue to refetch it
 * and rebuild the entries, then re-apply the frame that triggered the reload.
 */
async function refreshRig(stamp) {
  try {
    const config = await fetchJson(`${API}/config`)
    S.config = { ...S.config, rig: config.rig }
    installRig()
    S.rigStamp = stamp
    const params = S.lastStage?.params
    if (params !== null && typeof params === 'object' && S.rig !== null) {
      for (const entry of S.rig.entries) {
        const value = Number(params[entry.id])
        if (Number.isFinite(value)) entry.target = Math.min(entry.max, Math.max(entry.min, value))
      }
    }
  } catch (error) {
    console.warn('[dsh-live-tavern] rig reload failed', error)
  }
}

function removeRig() {
  if (S.rig === null) return
  try {
    S.model?.internalModel?.off?.('beforeModelUpdate', S.rig.apply)
  } catch {
    // Unhooking a handler from a disposed model is best-effort.
  }
  S.rig = null
}

/** The floating panel moved to 设置 → Live2D; kept as the post-action refresh hook. */
function renderPanel() {
  // Intentionally empty: the workbench renders its own results.
}

function watchLayout() {
  const reattach = () => {
    if (S.disposed) return
    if (S.app === null && S.vrm === null) {
      // The shell can mount after this plugin activates; retry the stage then.
      if (!S.starting && S.config !== null && anchorFor(S.config.placement[0] ?? 'chat') !== null) {
        void startEngine().catch(showError)
      }
      return
    }
    if (S.kind === 'vrm') {
      fitVrm()
      return
    }
    if (S.primary === null) return
    for (const placement of S.config.placement) {
      const seat = ensureSeat(placement)
      if (seat === null) continue
      if (placement === S.primary.placement && S.primary.host.isConnected === false && seat.contains(S.primary.host) === false) {
        seat.append(S.primary.host)
      }
    }
    fitModel()
  }
  const observer = new MutationObserver(() => {
    if (reattachTimer !== 0) return
    reattachTimer = window.setTimeout(() => {
      reattachTimer = 0
      reattach()
    }, 240)
  })
  let reattachTimer = 0
  observer.observe(document.body, { childList: true, subtree: true })
  const onResize = () => fitModel()
  window.addEventListener('resize', onResize)
  S.observers.push(() => {
    observer.disconnect()
    window.removeEventListener('resize', onResize)
    if (reattachTimer !== 0) clearTimeout(reattachTimer)
  })
}

/**
 * Re-apply the saved settings without a page reload.
 *
 * The engine is built once with the model and the texture level, so those two
 * still need a reload; everything else the settings page can change is a number
 * or a placement the running stage can adopt immediately.
 */
async function refreshDisplayConfig() {
  let next
  try {
    next = await fetchJson(`${API}/config`)
  } catch {
    return
  }
  const needsEngine = S.config?.selected?.id !== next?.selected?.id
    || S.config?.stageKind !== next?.stageKind
    || S.config?.textureLod !== next?.textureLod
    || S.config?.lookAtPointer !== next?.lookAtPointer
  S.config = { ...S.config, ...next }
  if (needsEngine) {
    // Swapping the model or the texture level rebuilds the engine, which only a
    // reload does cleanly.
    location.reload()
    return
  }
  if (S.kind === 'vrm') {
    // The 3D stage has no Live2D placements, rig or texture levels to refresh.
    applySpringStrength(S.vrm)
    fitVrm()
    return
  }
  if (S.app === null) return
  applyPlacements(next.placement)
  fitModel()
  installRig()
}

/**
 * Render the plugin's settings form into a host element.
 *
 * The descriptors come from the Host, so the form and the validation can never
 * drift apart. Saving writes the Host's settings file; display-level values need
 * a page refresh and host-level ones need a restart, which the footer says.
 */
async function mountSettingsForm(container) {
  container.textContent = ''
  const status = el('p', { class: 'status', text: '读取中…' })
  container.append(status)
  let payload
  try {
    payload = await fetchJson(`${API}/settings`)
  } catch (error) {
    status.textContent = `读取设置失败：${error?.message ?? error}`
    return
  }
  container.textContent = ''
  const draft = { ...payload.values }
  const defaults = { ...FALLBACK_DEFAULTS, ...(payload.defaults ?? {}) }
  const saved = el('span', { class: 'status' })
  let timer = 0

  const flush = async () => {
    timer = 0
    saved.dataset.state = 'busy'
    saved.textContent = '保存中…'
    try {
      await fetchJson(`${API}/settings`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(draft),
      })
      saved.dataset.state = 'ok'
      saved.textContent = '已保存'
      await refreshDisplayConfig()
    } catch (error) {
      saved.dataset.state = 'error'
      saved.textContent = `保存失败：${error?.message ?? error}`
    }
  }

  /** Coalesce keystrokes; selects and switches go out almost immediately. */
  const commit = (delay = 120) => {
    if (timer !== 0) clearTimeout(timer)
    timer = window.setTimeout(flush, delay)
  }

  const grid = el('div', { class: 'grid' })
  // The scope row follows the cross-session switch without rebuilding the form.
  let scopeCell = null
  for (const field of payload.fields) {
    if (field.hidden === true) continue
    // A field can depend on another one: 记忆范围 only means something while the
    // cross-session mode is on, so it hides otherwise instead of explaining itself.
    const shown = field.showWhen === undefined || draft[field.showWhen.key] === field.showWhen.equals
    const cell = el('div', { class: field.wide === true ? 'field wide' : 'field' })
    if (field.key === 'memoryScope') {
      scopeCell = cell
      if (!shown) cell.style.display = 'none'
    } else if (!shown) {
      continue
    }
    // The description is a hover hint, not a line: it would double the height of
    // every row for text that is read once.
    const label = el('label', { for: `dsh-l2d-set-${field.key}`, text: field.label })
    if (field.hint !== undefined) {
      // Every field keeps its description on hover only, switches included.
      cell.title = field.hint
      label.dataset.hint = '1'
    }
    cell.append(label)
    const control = buildControl(field, draft[field.key], (value) => {
      draft[field.key] = value
      commit(field.kind === 'text' ? 500 : 120)
    })
    cell.append(control.node)
    const fallback = defaults[field.key]
    cell.append(fallback === undefined
      ? el('span', { class: 'pad' })
      : el('button', {
        class: 'reset',
        text: '↺',
        title: `还原：${fallback === '' ? '空' : String(fallback)}`,
        onclick: (event) => {
          event.preventDefault()
          draft[field.key] = fallback
          control.set(fallback)
          commit(60)
        },
      }))
    grid.append(cell)
  }

  const reload = el('button', {
    type: 'button',
    text: '重新加载页面',
    title: '换模型、换贴图精度等改动需要整页刷新才会重建渲染器',
    onclick: () => location.reload(),
  })
  const recenter = el('button', {
    type: 'button',
    text: '全部归位',
    title: '把这个浏览器里的位置、身高与气泡偏移恢复默认（不影响别的浏览器）',
    onclick: () => {
      resetLayout('全部归位 button')
      renderLayoutBlock()
      recenter.textContent = '已归位'
      setTimeout(() => { recenter.textContent = '全部归位' }, 900)
    },
  })
  container.append(
    grid,
    mountDirectorModelPicker(draft, commit),
    el('div', { class: 'actions' }, [reload, recenter, saved]),
  )
  container.append(mountLayoutBlock())
  container.append(mountWorldbookBlock())
  // The workbench is a three-pane desktop editor; the phone shell has no room for it and the
  // Host does not serve its routes there.
  if (S.config?.capabilities?.workbench !== false) container.append(mountWorkbenchLauncher())
}

/**
 * Build one settings control.
 *
 * @returns The element to mount and a setter used by the reset button, so a
 * reset updates the widget and the draft from one value.
 */
function buildControl(field, value, onChange) {
  const id = `dsh-l2d-set-${field.key}`
  if (field.kind === 'select') {
    const select = el('select', { id })
    for (const option of field.options) {
      const item = el('option', { value: option, text: field.optionLabels?.[option] ?? option })
      if (String(value) === option) item.selected = true
      select.append(item)
    }
    select.addEventListener('change', () => onChange(select.value))
    return { node: select, set: (next) => { select.value = String(next) } }
  }
  if (field.kind === 'boolean') {
    const input = el('input', { id, type: 'checkbox' })
    input.checked = value === true
    input.addEventListener('change', () => {
      onChange(input.checked)
      if (field.key === 'director' && scopeCell !== null) {
        scopeCell.style.display = input.checked ? '' : 'none'
      }
    })
    // The old inline note doubled the row height for a sentence read once: the
    // description is now a hover hint, and the control is a real switch.
    const wrap = el('label', { class: 'switch', for: id })
    if (field.hint !== undefined) {
      wrap.title = field.hint
      wrap.setAttribute('aria-label', field.hint)
    } else {
      wrap.setAttribute('aria-label', field.label)
    }
    const track = el('span', { class: 'track' })
    wrap.append(input, track)
    return { node: wrap, set: (next) => { input.checked = next === true } }
  }
  const kind = field.kind === 'number' ? 'number' : 'text'
  const input = el('input', { id, type: kind, value: String(value ?? '') })
  if (kind === 'number') input.step = 'any'
  input.addEventListener('input', () => {
    if (kind === 'number') {
      onChange(input.value === '' ? 0 : Number(input.value))
      return
    }
    onChange(input.value)
  })
  if (field.pick !== 'directory') {
    return { node: input, set: (next) => { input.value = String(next ?? '') } }
  }
  // A path on this machine cannot be typed from memory and a browser directory
  // input only reveals file names, so the Host's own chooser supplies it.
  const browse = el('button', {
    class: 'pick',
    text: '浏览…',
    type: 'button',
    onclick: async (event) => {
      event.preventDefault()
      browse.disabled = true
      // Ask first: a probe reports the chooser without opening one, so a refusal
      // can say why instead of flashing a generic label.
      try {
        const probe = await fetchJson(`${API}/directory?probe=1`)
        if (probe?.canPick !== true) {
          browse.title = probe?.kind === undefined || probe.kind === 'none'
            ? '宿主没有可用的目录选择服务'
            : `当前宿主用浏览器内目录浏览（${probe.kind}），弹不出系统对话框`
          browse.textContent = '不可用'
          window.setTimeout(() => { browse.textContent = '浏览…' }, 2200)
          return
        }
      } catch (error) {
        browse.title = error?.message ?? String(error)
        browse.textContent = '不可用'
        window.setTimeout(() => { browse.textContent = '浏览…' }, 2200)
        return
      } finally {
        browse.disabled = false
      }
      browse.disabled = true
      try {
        const result = await fetchJson(`${API}/directory`)
        if (typeof result?.path === 'string' && result.path !== '') {
          input.value = result.path
          onChange(result.path)
        }
      } catch (error) {
        browse.textContent = '选不了'
        browse.title = error?.message ?? String(error)
        window.setTimeout(() => { browse.textContent = '浏览…' }, 1600)
      } finally {
        browse.disabled = false
      }
    },
  })
  const wrap = el('div', { class: 'pickrow' })
  wrap.append(input, browse)
  return { node: wrap, set: (next) => { input.value = String(next ?? '') } }
}

/**
 * Position sliders for the character and the speech bubble.
 *
 * They write the same browser-local layout the body drag writes, so dragging the
 * character updates these sliders and moving a slider moves the character — one
 * number, two controls. Sliders are the only way to place her in the chat seat,
 * where the transcript covers her body and body drag cannot reach it.
 */
function mountLayoutBlock() {
  const block = el('div', { class: 'block' })
  block.append(el('h3', { text: '位置' }))
  const grid = el('div', { class: 'grid' })
  const entries = []

  const addSlider = (group, axis, label, span, options = {}) => {
    const field = el('div', { class: 'field' })
    const suffix = options.suffix ?? ' px'
    if (options.hint !== undefined) {
      field.title = options.hint
      field.dataset.hint = '1'
    }
    const min = options.min ?? -span
    const step = options.step ?? '2'
    const caption = el('label', { text: `${label}：${formatLayout(group, axis)}${suffix}` })
    if (options.hint !== undefined) caption.dataset.hint = '1'
    const input = el('input', {
      type: 'range',
      min: String(min),
      max: String(span),
      step,
      value: String(layoutValue(group, axis)),
    })
    input.addEventListener('input', () => setLayoutValue(group, axis, Number(input.value)))
    const fallback = layoutDefault(group, axis)
    field.append(caption, input, el('button', {
      class: 'reset',
      type: 'button',
      text: '↺',
      title: `还原为 ${formatLayoutValue(group, axis, fallback)}${suffix}`,
      onclick: (event) => {
        event.preventDefault()
        event.stopPropagation()
        // Write this one value only: a full re-render here used to repaint every
        // caption, which read as "all sliders reset at once".
        if (group === 'layout') S.layout[axis] = fallback
        else S.layout[group][axis] = fallback
        if (group === 'bubble') positionBubble()
        else if (S.kind === 'vrm') fitVrm()
        else fitModel()
        saveLayout()
        input.value = String(fallback)
        caption.textContent = `${label}：${formatLayoutValue(group, axis, fallback)}${suffix}`
        console.info('[dsh-live-tavern] layout reset', `${group}.${axis}`, '→', fallback)
      },
    }))
    grid.append(field)
    entries.push({ group, axis, label, input, caption, suffix })
  }

  addSlider('model', 'x', '角色水平', 700, { hint: '角色左右位置，负数向左；只影响这个浏览器' })
  addSlider('model', 'y', '角色垂直', 700, { hint: '角色上下位置，负数向上；脚底默认贴着屏幕下沿' })
  addSlider('layout', 'height', '身高占比', 1.6, { min: 0.2, step: '0.02', suffix: '', hint: '她占屏幕高度的多少倍：0.92≈九成屏高，超过 1 会顶出屏幕' })
  addSlider('bubble', 'x', '气泡水平', 1600, { hint: '台词气泡相对角色中心的左右偏移；范围 ±1600px' })
  addSlider('bubble', 'y', '气泡垂直', 900, { hint: '台词气泡上下偏移；正值往下，范围 ±900px' })
  S.layoutSliders = entries
  previewBubble(true)
  block.append(grid)
  return block
}

/** One place that moves the stage, so every control agrees. */
function setLayoutValue(group, axis, value) {
  if (group === 'layout') S.layout[axis] = value
  else S.layout[group][axis] = value
  if (group === 'bubble') positionBubble()
  else fitModel()
  saveLayout()
  renderLayoutBlock()
}

/** One layout value, whether it is a per-axis offset or a scalar knob. */
function layoutValue(group, axis) {
  const raw = group === 'layout' ? S.layout?.[axis] : S.layout?.[group]?.[axis]
  const value = Number(raw)
  return Number.isFinite(value) ? value : layoutDefault(group, axis)
}

/** The value a layout slider's ↺ restores. */
function layoutDefault(group, axis) {
  if (group !== 'layout') return 0
  return axis === 'height' ? 0.92 : 1
}

/** Render one layout value the way its slider labels it. */
function formatLayout(group, axis) {
  return formatLayoutValue(group, axis, layoutValue(group, axis))
}

function formatLayoutValue(group, axis, value) {
  if (group !== 'layout') return String(value)
  return Number(value).toFixed(2)
}

/** Refresh the Position sliders after a reset or a body drag. */
function renderLayoutBlock() {
  for (const entry of S.layoutSliders ?? []) {
    const value = layoutValue(entry.group, entry.axis)
    entry.input.value = String(value)
    entry.caption.textContent = `${entry.label}：${formatLayout(entry.group, entry.axis)}${entry.suffix}`
  }
}

/**
 * Every parameter the running Cubism model declares.
 *
 * `cdi3.json` is display information and may list only the parameters its author cared
 * about, so a workbench built from it alone hides real channels. The core model is the
 * authority; this reads its id vector when the engine exposes one.
 *
 * @returns Parameter ids, or an empty list when the engine hides them.
 */
function coreParameterIds() {
  const core = S.rig?.core
  const inner = core?._model ?? core?.model ?? S.model?.internalModel?.coreModel?._model ?? null
  const ids = inner?.parameters?.ids
  if (ids === null || ids === undefined) return []
  try {
    const size = typeof ids.getSize === 'function' ? ids.getSize() : (Array.isArray(ids) ? ids.length : 0)
    const out = []
    for (let index = 0; index < size; index += 1) {
      const entry = typeof ids.at === 'function' ? ids.at(index) : ids[index]
      const text = typeof entry?.getString === 'function'
        ? entry.getString()
        : (typeof entry?.s === 'string' ? entry.s : String(entry ?? ''))
      if (typeof text === 'string' && text !== '') out.push(text)
    }
    return out
  } catch {
    return []
  }
}

/**
 * The live range of one parameter.
 *
 * Cubism reports ranges by parameter INDEX (`getParameterMinimumValue(index)`),
 * so passing an id handle there silently yields `undefined` and the slider ends
 * up with a nonsense range. Resolve the index first, then guard the numbers.
 *
 * @param id - Parameter id.
 * @returns `{ min, max }`, falling back to -1..1 when the model has no such id.
 */
function parameterRangeOf(id) {
  const fallback = { min: -1, max: 1 }
  if (S.rig === null || !S.rig.core) return fallback
  const core = S.rig.core
  try {
    const handle = S.rig.handleFor(id)
    const index = typeof core.getParameterIndex === 'function' ? core.getParameterIndex(handle) : -1
    if (!Number.isFinite(index) || index < 0) return fallback
    const min = core.getParameterMinimumValue(index)
    const max = core.getParameterMaximumValue(index)
    if (!Number.isFinite(min) || !Number.isFinite(max) || min === max) return fallback
    return { min, max }
  } catch {
    return fallback
  }
}

/**
 * The cross-session model picker, shaped like the composer's model seat.
 *
 * The composer's picker is a two-row root menu — model, then effort — with each
 * row drilling into its own list. This is the same shape: the root offers 模型 and
 * 思考强度, the model pane groups by provider with a search field, and the effort
 * pane lists only what the chosen model declares.
 *
 * @param draft - The settings draft being edited.
 * @param commit - Called after a choice so the form saves.
 * @returns The row element.
 */
function mountDirectorModelPicker(draft, commit) {
  const row = el('div', { class: 'field picker' })
  const pickerLabel = el('label', { text: '跨会话模型' })
  pickerLabel.title = '场外模型：单独选 provider、模型与思考强度；留空则跟随本会话的模型'
  pickerLabel.dataset.hint = '1'
  row.title = pickerLabel.title
  row.append(pickerLabel)
  const trigger = el('button', { class: 'trigger', type: 'button', 'aria-haspopup': 'menu' })
  row.append(trigger)
  row.append(el('button', {
    class: 'reset',
    type: 'button',
    text: '↺',
    title: '还原为跟随本会话',
    onclick: (event) => {
      event.preventDefault()
      draft.directorProvider = ''
      draft.directorModel = ''
      draft.directorEffort = ''
      render()
      commit(60)
    },
  }))

  /** `{ [provider/model]: { efforts, defaultEffort } }`, filled by the catalog. */
  let catalogInfo = {}
  /** The last catalog payload, so drilling into a pane does not lose the list. */
  let catalogData
  const effortsOf = () => {
    if (draft.directorModel === '') return []
    const entry = catalogInfo[`${draft.directorProvider}/${draft.directorModel}`]
    return Array.isArray(entry?.efforts) ? entry.efforts : []
  }
  const effortName = () => {
    if (draft.directorEffort === '') return ''
    const found = effortsOf().find(effort => effort.id === draft.directorEffort)
    return found === undefined ? String(draft.directorEffort) : found.name
  }
  const modelLabel = () => (draft.directorModel === '' ? '跟随本会话' : String(draft.directorModel))

  const render = () => {
    trigger.replaceChildren()
    trigger.append(el('span', { class: 'value', text: `${modelLabel()}${effortName() === '' ? '' : ` · ${effortName()}`}` }))
    trigger.append(el('span', { class: 'chevron', text: '⌄' }))
  }
  render()

  let menu = null
  let detach = null
  let items = []

  const closeMenu = () => {
    if (menu === null) return
    menu.remove()
    menu = null
    items = []
    detach?.()
    detach = null
    trigger.setAttribute('aria-expanded', 'false')
  }

  const place = (node) => {
    const box = trigger.getBoundingClientRect()
    const width = 300
    node.style.left = `${Math.round(Math.min(Math.max(8, box.left), Math.max(8, window.innerWidth - width - 8)))}px`
    node.style.top = `${Math.round(box.bottom + 4)}px`
    node.style.maxHeight = `${Math.round(Math.min(340, Math.max(160, window.innerHeight - box.bottom - 16)))}px`
  }

  const commitChoice = () => {
    render()
    closeMenu()
    commit(120)
  }

  /** One clickable row; `hint` renders on the right. */
  const menuRow = (text, hint, onPick, active) => {
    const item = el('button', { class: 'item', type: 'button' })
    item.append(el('span', { class: 'item-name', text }))
    if (hint !== undefined && hint !== '') item.append(el('span', { class: 'item-hint', text: hint }))
    if (active === true) item.dataset.active = '1'
    item.addEventListener('click', onPick)
    item.addEventListener('pointerenter', () => {
      items.forEach(entry => { entry.dataset.highlight = entry === item ? '1' : '0' })
    })
    items.push(item)
    return item
  }

  /** The root pane: the two rows the composer shows. */
  const showRoot = () => {
    if (menu === null) return
    items = []
    const list = el('div', { class: 'list' })
    const efforts = effortsOf()
    list.append(menuRow('模型', modelLabel(), () => showModels(catalogData), true))
    if (efforts.length === 0) {
      list.append(menuRow('思考强度', draft.directorModel === '' ? '跟随本会话' : '该模型不支持', () => showModels(catalogData)))
    } else {
      list.append(menuRow('思考强度', effortName() === '' ? '默认' : effortName(), () => showEfforts()))
    }
    menu.replaceChildren(list)
  }

  /** The model pane: provider groups with a search field. */
  const showModels = (data) => {
    if (menu === null) return
    items = []
    const search = el('input', { type: 'text', placeholder: '搜索模型，例如 deepseek' })
    const list = el('div', { class: 'list' })
    menu.replaceChildren(search, list)

    if (data !== undefined) {
      const selectedKey = draft.directorProvider === '' && draft.directorModel === ''
        ? 'session'
        : `${draft.directorProvider}/${draft.directorModel}`
      const searchable = []
      const add = (key, text, hint, onPick) => {
        const item = menuRow(text, hint, onPick, key === selectedKey)
        searchable.push({ item, text: `${text} ${hint ?? ''}`.toLowerCase() })
        list.append(item)
      }
      list.append(el('div', { class: 'group', text: '本会话' }))
      add('session', '跟随本会话', data.session?.model ?? '', () => {
        draft.directorProvider = ''
        draft.directorModel = ''
        draft.directorEffort = ''
        commitChoice()
      })
      for (const provider of data.providers ?? []) {
        list.append(el('div', { class: 'group', text: provider.label }))
        if (!Array.isArray(provider.models) || provider.models.length === 0) {
          list.append(el('div', { class: 'empty', text: '这个 provider 没有可列出的模型' }))
          continue
        }
        for (const model of provider.models) {
          add(`${provider.provider}/${model.id}`, model.name, provider.label, () => {
            draft.directorProvider = provider.provider
            draft.directorModel = model.id
            // An effort belongs to the model that declared it.
            const efforts = Array.isArray(model.efforts) ? model.efforts : []
            if (!efforts.some(effort => effort.id === draft.directorEffort)) draft.directorEffort = ''
            commitChoice()
          })
        }
      }
      search.addEventListener('input', () => {
        const needle = search.value.trim().toLowerCase()
        for (const entry of searchable) entry.item.hidden = needle !== '' && !entry.text.includes(needle)
      })
    }
    search.focus()
  }

  /** The effort pane: only what the chosen model declares. */
  const showEfforts = () => {
    if (menu === null) return
    items = []
    const list = el('div', { class: 'list' })
    const efforts = effortsOf()
    list.append(el('div', { class: 'group', text: draft.directorModel }))
    list.append(menuRow('默认', '由 provider 决定', () => {
      draft.directorEffort = ''
      commitChoice()
    }, draft.directorEffort === ''))
    for (const effort of efforts) {
      list.append(menuRow(effort.name, effort.description ?? '', () => {
        draft.directorEffort = effort.id
        commitChoice()
      }, draft.directorEffort === effort.id))
    }
    menu.replaceChildren(list)
  }

  const openMenu = () => {
    menu = el('div', { class: 'dsh-l2d-menu' })
    menu.append(el('div', { class: 'empty', text: '读取模型列表…' }))
    document.body.append(menu)
    place(menu)
    trigger.setAttribute('aria-expanded', 'true')

    const onDown = (event) => {
      if (menu !== null && !menu.contains(event.target) && !trigger.contains(event.target)) closeMenu()
    }
    const onKey = (event) => {
      if (menu === null) return
      if (event.key === 'Escape') {
        event.preventDefault()
        closeMenu()
        return
      }
      if (items.length === 0) return
      const current = items.findIndex(item => item.dataset.highlight === '1')
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        const next = (current + (event.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length
        items.forEach((item, index) => { item.dataset.highlight = index === next ? '1' : '0' })
        items[next].scrollIntoView({ block: 'nearest' })
        return
      }
      if (event.key === 'Enter' && current >= 0) {
        event.preventDefault()
        items[current].click()
      }
    }
    // A capture scroll listener hears every scroller, including this menu's own
    // list; closing on that made the menu vanish on the first hover.
    const onScroll = (event) => {
      if (menu === null) return
      if (event.target instanceof Node && menu.contains(event.target)) return
      closeMenu()
    }
    const onResize = () => closeMenu()

    window.addEventListener('pointerdown', onDown, true)
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('resize', onResize)
    window.addEventListener('scroll', onScroll, true)
    detach = () => {
      window.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('resize', onResize)
      window.removeEventListener('scroll', onScroll, true)
    }

    void fetchJson(`${API}/models/catalog`)
      .then((data) => {
        if (menu === null) return
        catalogData = data
        catalogInfo = {}
        for (const provider of data.providers ?? []) {
          for (const model of provider.models ?? []) {
            catalogInfo[`${provider.provider}/${model.id}`] = model
          }
        }
        render()
        showRoot()
      })
      .catch((error) => {
        if (menu === null) return
        menu.replaceChildren(el('div', { class: 'empty', text: `读取模型失败：${error?.message ?? error}` }))
      })
  }
  trigger.addEventListener('click', (event) => {
    event.preventDefault()
    if (menu === null) openMenu()
    else closeMenu()
  })
  return row
}

/**
 * The parameter workbench, as its own screen.
 *
 * Left: every parameter the model declares, with a live slider, a note and a
 * confirmation box. Right: the model itself, moved into that pane so the art and
 * the slider sit side by side while the note is written.
 *
 * @returns The overlay element, already mounted on `document.body`.
 */
function openWorkbench() {
  if (S.workbench !== null) return S.workbench
  const overlay = el('div', { class: 'dsh-l2d-wb' })
  const bar = el('div', { class: 'wb-bar' })
  const title = el('span', { class: 'wb-title', text: '参数工作台' })
  const state = el('span', { class: 'wb-state', text: '读取参数表…' })
  const stage = el('div', { class: 'wb-stage' })
  const close = el('button', {
    class: 'wb-close',
    text: '关闭',
    onclick: () => closeWorkbench(),
  })
  bar.append(title, state, close)

  const left = el('div', { class: 'wb-left' })
  const right = el('div', { class: 'wb-right' })
  right.append(stage)
  right.append(el('div', {
    class: 'wb-hint',
    text: '拖动移动 · 滚轮缩放 · 双击复位',
  }))
  const splitter = el('div', { class: 'wb-split', title: '拖动调整宽度' })
  const body = el('div', { class: 'wb-body' })
  body.append(left, splitter, right)

  const widthKey = 'dsh-live-tavern-lite-split'
  let width = 430
  try {
    const stored = Number(localStorage.getItem(widthKey))
    if (Number.isFinite(stored) && stored >= 260) width = stored
  } catch {
    // A blocked storage just means the default width.
  }
  const applyWidth = (value) => {
    width = Math.min(720, Math.max(260, value))
    body.style.setProperty('--wb-left', `${width}px`)
    try {
      localStorage.setItem(widthKey, String(width))
    } catch {
      // Private-mode storage may refuse the write; the drag still works.
    }
  }
  applyWidth(width)
  splitter.addEventListener('pointerdown', (event) => {
    event.preventDefault()
    splitter.setPointerCapture?.(event.pointerId)
    const startX = event.clientX
    const startWidth = width
    splitter.classList.add('dragging')
    const move = (moveEvent) => applyWidth(startWidth + (moveEvent.clientX - startX))
    const stop = () => {
      splitter.classList.remove('dragging')
      splitter.removeEventListener('pointermove', move)
      splitter.removeEventListener('pointerup', stop)
      splitter.removeEventListener('pointercancel', stop)
    }
    splitter.addEventListener('pointermove', move)
    splitter.addEventListener('pointerup', stop)
    splitter.addEventListener('pointercancel', stop)
  })
  overlay.append(bar, body)
  document.body.append(overlay)
  S.workbench = overlay

  // The stage lives in the right pane while this screen is open.
  S.workbenchPane = stage
  applyPlacements(S.config?.placement ?? ['chat'])

  let drag = null
  stage.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return
    event.preventDefault()
    stage.setPointerCapture?.(event.pointerId)
    stage.classList.add('dragging')
    drag = { x: event.clientX, y: event.clientY, ox: S.workbenchOffset.x, oy: S.workbenchOffset.y }
    const move = (moveEvent) => {
      if (drag === null) return
      // A preview nudge must not change the saved layout: the settings page would
      // then show a position the user never chose.
      S.workbenchOffset = {
        x: drag.ox + (moveEvent.clientX - drag.x),
        y: drag.oy + (moveEvent.clientY - drag.y),
      }
      if (S.kind === 'vrm') fitVrm()
      else fitModel()
    }
    const stop = () => {
      if (drag !== null && S.kind === 'vrm') fitVrm()
      drag = null
      stage.classList.remove('dragging')
      stage.removeEventListener('pointermove', move)
      stage.removeEventListener('pointerup', stop)
      stage.removeEventListener('pointercancel', stop)
    }
    stage.addEventListener('pointermove', move)
    stage.addEventListener('pointerup', stop)
    stage.addEventListener('pointercancel', stop)
  })
  stage.addEventListener('wheel', (event) => {
    event.preventDefault()
    // Preview zoom is temporary too: the saved height belongs to the settings page.
    const factor = Math.exp(-event.deltaY * 0.0016)
    S.workbenchHeight = Math.min(1.6, Math.max(0.2, (S.workbenchHeight ?? S.layout.height) * factor))
    if (S.kind === 'vrm') fitVrm()
    else fitModel()
  }, { passive: false })
  stage.addEventListener('dblclick', (event) => {
    event.preventDefault()
    S.workbenchHeight = S.layout.height
    S.workbenchOffset = { x: 0, y: 0 }
    if (S.kind === 'vrm') fitVrm()
    else fitModel()
  })

  void mountWorkbenchBody(left, state, title)
  return overlay
}

/** Put the model back in its configured seat and drop the overlay. */
function closeWorkbench() {
  if (S.workbench === null) return
  const overlay = S.workbench
  S.workbench = null
  S.workbenchPane = null
  S.workbenchOffset = { x: 0, y: 0 }
  S.workbenchHeight = undefined
  overlay.remove()
  // The seat has to be reclaimed for either stage: for a 3D model the canvas was
  // living inside the workbench pane, so removing the overlay would take the model
  // with it.
  if (S.kind === 'vrm' || S.app !== null) applyPlacements(S.config?.placement ?? ['chat'])
}

/**
 * The default pose, edited in the workbench.
 *
 * Saved into the pack and applied once after load, before any frame arrives. Two
 * independent choices: a model expression file, and a prototype the stage already
 * knows how to resolve — either alone is enough, both together compose.
 */
function mountWorkbenchDefaults(defaults, expressions, emotions, presets = []) {
  const block = el('div', { class: 'wb-defaults' })
  block.append(el('h4', { text: '默认表情' }))
  const expression = el('select', { title: '模型自己声明的表情文件；加载完成后自动套用' })
  expression.append(el('option', { value: '', text: '（不用表情文件）' }))
  for (const name of expressions) expression.append(el('option', { value: name, text: name }))
  expression.value = defaults?.expression ?? ''
  const emotion = el('select', { title: '情绪原型；Live2D 走映射表，VRM 走自带表情' })
  emotion.append(el('option', { value: '', text: '（不设情绪）' }))
  for (const id of emotions) emotion.append(el('option', { value: id, text: id }))
  if (presets.length > 0) {
    // Custom presets are ids the resolver already knows, so they belong in the same
    // list as the built-in prototypes.
    const group = el('optgroup', { label: '预设表情' })
    for (const preset of presets) group.append(el('option', { value: preset.id, text: `${preset.id} · ${preset.label}` }))
    emotion.append(group)
  }
  emotion.value = defaults?.emotion ?? ''
  const status = el('span', { class: 'wb-hint-inline', text: '' })
  const save = el('button', {
    type: 'button',
    text: '保存为默认',
    title: '写入角色包的 defaults.json，下次加载自动套用',
    onclick: async () => {
      save.disabled = true
      try {
        const answer = await fetchJson(`${API}/defaults`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ expression: expression.value, emotion: emotion.value }),
        })
        S.config = { ...S.config, defaults: answer.defaults }
        status.textContent = '已保存，下次加载即生效'
        applyDefaults(answer.defaults, { force: true })
      } catch (error) {
        status.textContent = `保存失败：${error?.message ?? error}`
      } finally {
        save.disabled = false
      }
    },
  })
  const row = el('div', { class: 'wb-defaults-row' })
  row.append(expression, emotion, save, status)
  block.append(row)
  return block
}

/**
 * Apply the saved pose once.
 *
 * Called after the model is ready and again when the workbench saves, so the change is
 * visible immediately without a reload.
 */
function applyDefaults(defaults, options = {}) {
  if (defaults === null || defaults === undefined) return
  if (S.defaultsApplied === true && options.force !== true) return
  S.defaultsApplied = true
  const named = typeof defaults.emotion === 'string' && defaults.emotion !== ''
  if (named) {
    // The Host resolves a prototype or a preset into concrete targets; asking it keeps
    // the mapping in one place instead of duplicating the table in the browser.
    void fetchJson(`${API}/stage/preview?emotion=${encodeURIComponent(defaults.emotion)}`)
      .then((frame) => {
        if (frame === null) return
        if (S.kind === 'vrm') applyVrmFrame(frame)
        else applyStage(frame)
      })
      .catch(() => { /* an unavailable preview just leaves the neutral pose */ })
  }
  if (typeof defaults.expression === 'string' && defaults.expression !== '') {
    if (S.kind === 'vrm') {
      const manager = S.vrm?.vrm?.expressionManager
      if (manager !== undefined && manager !== null) {
        try {
          manager.setValue(defaults.expression, 1)
        } catch {
          // A name the model does not declare is simply not applied.
        }
      }
    } else if (S.model !== null) {
      S.model.expression(defaults.expression).catch(() => { /* same rule */ })
    }
  }
}

/**
 * The parameter workbench for a 3D model.
 *
 * A VRM has no `cdi3.json`, so the editable list is the bone channels the stage
 * drives. Each row works like its Live2D counterpart: a slider that moves the model
 * live, a note, and a confirmation mark — and the note reaches the prompt, which is
 * the whole reason to write one.
 */
async function mountVrmWorkbenchBody(left, state, title) {
  left.textContent = ''
  let payload
  try {
    payload = await fetchJson(`${API}/params`)
  } catch (error) {
    state.textContent = `读取失败：${error?.message ?? error}`
    return
  }
  // cdi3 is a display list, not a declaration: merge in what the model really carries.
  const declared = Array.isArray(payload.ids) ? payload.ids : []
  const ids = [...new Set([...declared, ...coreParameterIds()])]
  if (ids.length === 0) {
    state.textContent = '这个模型没有可驱动的骨骼通道。'
    return
  }
  const notes = { ...payload.notes }
  title.textContent = `参数工作台 · ${payload.model}`
  const noted = ids.filter(id => typeof notes[id]?.note === 'string' && notes[id].note !== '').length
  state.textContent = `${ids.length} 个骨骼通道 · 已备注 ${noted} 个`

  let timer = 0
  // The count this panel was opened with: the Host refuses an empty save that does
  // not match it, so a stale tab cannot wipe the file.
  let loadedCount = Object.keys(notes).length
  const flush = async () => {
    state.textContent = '保存备注…'
    try {
      const answer = await fetchJson(`${API}/params`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ params: notes, expected: loadedCount }),
      })
      loadedCount = Object.keys(answer?.params ?? notes).length
      state.textContent = '备注已保存'
    } catch (error) {
      state.textContent = `保存失败：${error?.message ?? error}`
    }
  }
  const scheduleSave = () => {
    if (timer !== 0) clearTimeout(timer)
    timer = window.setTimeout(flush, 700)
  }

  const filter = el('input', { type: 'text', placeholder: '过滤通道，例如 Head / Arm / Spine' })
  const list = el('div', { class: 'wb-list' })
  const rows = []
  const touched = new Set()
  const probe = S.vrm.probe instanceof Map ? S.vrm.probe : new Map()
  S.vrm.probe = probe

  for (const id of ids) {
    const range = Array.isArray(payload.ranges?.[id]) ? payload.ranges[id] : [-45, 45]
    const min = range[0]
    const max = range[1]
    const row = el('div', { class: 'wb-row' })
    const name = el('span', { class: 'wb-id', text: id })
    const slider = el('input', {
      type: 'range',
      min: String(min),
      max: String(max),
      step: '1',
      value: String(Math.round((min + max) / 2)),
      title: '拖动试听（度），双击归位',
    })
    slider.addEventListener('input', () => {
      probe.set(id, Number(slider.value))
      touched.add(id)
    })
    slider.addEventListener('dblclick', () => {
      probe.delete(id)
      slider.value = String(Math.round((min + max) / 2))
      touched.delete(id)
    })
    const saved = notes[id]?.note
    const builtin = typeof payload.defaults?.[id] === 'string' ? payload.defaults[id] : ''
    const seeded = saved ?? builtin
    const note = el('input', {
      type: 'text',
      value: seeded,
      placeholder: '这个通道在这尊模型上意味着什么？',
      title: saved !== undefined
        ? '已保存的备注'
        : (builtin !== '' ? '内置默认含义（VRM 标准骨骼，任何模型通用）——改动才会保存' : '写一句备注，提示词里会附在通道名后面'),
    })
    if (saved === undefined && builtin !== '') note.dataset.seeded = '1'
    const mark = el('input', { type: 'checkbox' })
    mark.checked = notes[id]?.verified === true
    mark.title = '已确认：这是这台机器上的准确含义'
    const commit = () => {
      const value = note.value.trim()
      delete note.dataset.seeded
      // Leaving the built-in text untouched is not an edit: only a changed value or a
      // confirmation is stored.
      if (value === builtin && !mark.checked) delete notes[id]
      else if (value === '' && !mark.checked) delete notes[id]
      else notes[id] = { ...(value === '' ? {} : { note: value }), ...(mark.checked ? { verified: true } : {}) }
      scheduleSave()
    }
    note.addEventListener('input', commit)
    mark.addEventListener('change', commit)
    row.append(name, slider, note, mark)
    rows.push({ id, row, slider })
    list.append(row)
  }
  filter.addEventListener('input', () => {
    const needle = filter.value.trim().toLowerCase()
    for (const entry of rows) entry.row.hidden = needle !== '' && !entry.id.toLowerCase().includes(needle)
  })

  left.append(
    filter,
    list,
    el('p', {
      class: 'wb-hint-inline',
      text: '通道值单位是度，相对静止姿势。',
      title: '备注不进提示词：模型需要时会调用 live2d_params 读取',
    }),
    mountWorkbenchDefaults(payload.defaults ?? null, payload.expressions ?? [], payload.emotions ?? [], payload.presets ?? []),
    mountWorkbenchPresets(rows, touched),
    mountWorkbenchRecipe(state),
  )
}

/**
 * Authoring block: move the body down and save whatever is on the stage as a recipe.
 *
 * Poses are judged by eye, and the only eye at the stage is the player's, so the workbench has
 * to be able to write one back instead of describing it to someone else.
 */
function mountWorkbenchRecipe(state) {
  const box = el('div', { class: 'wb-recipe' })
  const vertical = el('input', {
    type: 'range',
    min: '-1.2',
    max: '0.4',
    step: '0.01',
    value: '0',
    title: '髋部升降（米）：负数下蹲，正数踮起。旋转做不到这个。',
  })
  const verticalLabel = el('span', { class: 'wb-id', text: '髋 0.00 m' })
  vertical.addEventListener('input', () => {
    const meters = Number(vertical.value)
    verticalLabel.textContent = `髋 ${meters.toFixed(2)} m`
    if (S.vrm !== null) S.vrm.translate = meters === 0 ? null : { hips: [0, meters, 0] }
  })
  const idInput = el('input', { type: 'text', placeholder: '配方 id，例如 crouch', value: '' })
  const labelInput = el('input', { type: 'text', placeholder: '中文名，例如 蹲下', value: '' })
  const save = el('button', { type: 'button', text: '把当前姿势存为配方' })
  save.addEventListener('click', async () => {
    const id = idInput.value.trim()
    if (id === '') {
      state.textContent = '先给配方起个 id'
      return
    }
    const params = {}
    for (const [channel, degrees] of S.vrm?.probe ?? []) {
      if (Math.abs(Number(degrees)) >= 0.5) params[channel] = Number(degrees)
    }
    const meters = Number(vertical.value)
    try {
      const answer = await fetchJson(`${API}/recipes`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          id,
          label: labelInput.value.trim() === '' ? id : labelInput.value.trim(),
          params,
          ...(meters === 0 ? {} : { translate: { hips: [0, meters, 0] } }),
        }),
      })
      state.textContent = `配方 ${answer?.id ?? id} 已保存（${answer?.params ?? 0} 条通道）`
    } catch (error) {
      state.textContent = `保存失败：${error?.message ?? error}`
    }
  })
  box.append(
    el('p', { class: 'wb-hint-inline', text: '摆好姿势 → 存为配方。模型之后就能直接调用这个 id。' }),
    verticalLabel,
    vertical,
    idInput,
    labelInput,
    save,
  )
  return box
}

/** Load the parameter table and fill the left pane. */
async function mountWorkbenchBody(left, state, title) {
  if (S.kind === 'vrm') return mountVrmWorkbenchBody(left, state, title)
  left.textContent = ''
  if (S.rig === null || !S.rig.core) {
    state.textContent = '舞台未运行，读不到参数量程。'
    return
  }
  let payload
  try {
    payload = await fetchJson(`${API}/params`)
  } catch (error) {
    state.textContent = `读取失败：${error?.message ?? error}`
    return
  }
  const ids = Array.isArray(payload.ids) ? payload.ids : []
  if (ids.length === 0) {
    state.textContent = '这个模型没有 cdi3.json，读不到参数清单。'
    return
  }
  const notes = { ...payload.notes }
  const rigged = new Set(payload.rig?.ids ?? [])
  title.textContent = `参数工作台 · ${payload.model}`
  state.textContent = `${ids.length} 个参数 · 已覆盖 ${rigged.size} 个 · ${payload.rig?.source === 'model' ? '模型自带表' : '插件默认表'}`

  let timer = 0
  // The count this panel was opened with: the Host refuses an empty save that does
  // not match it, so a stale tab cannot wipe the file.
  let loadedCount = Object.keys(notes).length
  const flush = async () => {
    state.textContent = '保存备注…'
    try {
      const answer = await fetchJson(`${API}/params`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ params: notes, expected: loadedCount }),
      })
      loadedCount = Object.keys(answer?.params ?? notes).length
      state.textContent = '备注已保存'
    } catch (error) {
      state.textContent = `保存失败：${error?.message ?? error}`
    }
  }
  const scheduleSave = () => {
    if (timer !== 0) clearTimeout(timer)
    timer = window.setTimeout(flush, 700)
  }

  const filter = el('input', { type: 'text', placeholder: '过滤参数 id，例如 Mouth / Eye / Skirt' })
  const list = el('div', { class: 'wb-list' })
  const rows = []
  /** Parameters the user moved in this session, captured into a preset. */
  const touched = new Set()
  for (const id of ids) {
    const handle = S.rig.handleFor(id)
    const range = parameterRangeOf(id)
    const min = range.min
    const max = range.max
    const midpoint = (min + max) / 2
    const row = el('div', { class: 'wb-row' })
    const name = el('span', { class: 'wb-id', text: id })
    if (rigged.has(id)) name.dataset.inRig = '1'
    const slider = el('input', {
      type: 'range',
      min: String(min),
      max: String(max),
      step: String(Math.max(0.01, (max - min) / 100)),
      value: String(midpoint.toFixed(2)),
      title: '拖动试听，双击归位',
    })
    slider.addEventListener('input', () => {
      S.rig.probe.set(handle, Number(slider.value))
      // A preset captures only what the user touched; seeding all 200 parameters
      // at their midpoints would pin the whole model.
      touched.add(id)
    })
    slider.addEventListener('dblclick', () => {
      S.rig.probe.delete(handle)
      slider.value = String(midpoint)
      touched.delete(id)
    })
    const described = payload.rig?.described?.[id]
    const saved = notes[id]?.note
    const seeded = saved ?? described?.note ?? described?.role ?? ''
    const note = el('input', {
      type: 'text',
      value: seeded,
      placeholder: '这个参数改变什么？',
      title: saved !== undefined ? '已保存的备注' : (described === undefined ? '' : '来自映射表，尚未保存为备注'),
    })
    if (saved === undefined && described !== undefined) note.dataset.seeded = '1'
    const mark = el('input', { type: 'checkbox' })
    mark.checked = notes[id]?.verified === true
    mark.title = '已确认：允许模型用它生成映射表'
    const commit = () => {
      const value = note.value.trim()
      delete note.dataset.seeded
      if (value === '' && !mark.checked) delete notes[id]
      else notes[id] = { ...(value === '' ? {} : { note: value }), ...(mark.checked ? { verified: true } : {}) }
      scheduleSave()
    }
    note.addEventListener('input', commit)
    mark.addEventListener('change', commit)
    row.append(name, slider, note, mark)
    rows.push({ id, row, slider })
    list.append(row)
  }
  filter.addEventListener('input', () => {
    const needle = filter.value.trim().toLowerCase()
    for (const entry of rows) entry.row.hidden = needle !== '' && !entry.id.toLowerCase().includes(needle)
  })

  // Once the model carries its own table, the two intents are genuinely
  // different: keep what the table already says, or throw it away.
  const hasOwnTable = payload.rig?.source === 'model'
  const runGenerate = (mode, button) => async () => {
    button.disabled = true
    state.textContent = mode === 'update' ? '更新中…（消耗一次模型调用）' : '生成中…（消耗一次模型调用）'
    try {
      const result = await fetchJson(`${API}/rig/generate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mode }),
      })
      const salvaged = typeof result.salvaged === 'number'
        ? `（原表被截断，保留了前 ${result.salvaged} 条，丢弃 ${result.dropped} 条）`
        : ''
      state.textContent = `${result.mode === 'update' ? '已更新' : '已生成'} ${result.params.length} 个参数${salvaged} → ${result.file}`
    } catch (error) {
      state.textContent = `${mode === 'update' ? '更新' : '生成'}失败：${error?.message ?? error}`
    } finally {
      button.disabled = false
    }
  }
  const actions = el('div', { class: 'wb-actions' })
  if (hasOwnTable) {
    const update = el('button', {
      class: 'wb-generate',
      text: '更新映射表',
      title: '保留表里已有的参数与权重，只补新备注提到的',
    })
    const regenerate = el('button', {
      class: 'wb-generate ghost',
      text: '重新生成',
      title: '丢掉现有表，完全按当前备注重做',
    })
    update.addEventListener('click', runGenerate('update', update))
    regenerate.addEventListener('click', runGenerate('regenerate', regenerate))
    actions.append(
      el('span', { class: 'wb-hint-inline', text: '已有映射表' }),
      update,
      regenerate,
    )
  } else {
    const generate = el('button', { class: 'wb-generate', text: '让模型按备注生成映射表' })
    generate.addEventListener('click', runGenerate('regenerate', generate))
    actions.append(generate)
  }
  // 列表与预设共用左栏的高度，由一根横分隔条分配
  const presetsPane = mountWorkbenchPresets(rows, touched)
  const presetsSplit = el('div', { class: 'wb-presets-split', title: '拖动调整参数列表与预设表情的高度比例' })
  bindPresetsSplit(presetsSplit, left)
  left.append(
    filter,
    list,
    actions,
    presetsSplit,
    mountWorkbenchDefaults(payload.defaults ?? null, payload.expressions ?? [], payload.emotions ?? [], payload.presets ?? []),
    presetsPane,
  )
}

/** Drag the divider between the parameter list and the preset pane. */
function bindPresetsSplit(splitter, left) {
  const key = 'dsh-live-tavern-lite-presets-h'
  const apply = (value) => {
    const total = left.clientHeight || 600
    const height = Math.min(Math.round(total * 0.7), Math.max(90, value))
    left.style.setProperty('--wb-presets', `${height}px`)
    try {
      localStorage.setItem(key, String(height))
    } catch {
      // A blocked storage keeps the value for this page only.
    }
  }
  try {
    const stored = Number(localStorage.getItem(key))
    if (Number.isFinite(stored) && stored >= 90) apply(stored)
  } catch {
    // No stored height: the CSS default stands.
  }
  let drag = null
  splitter.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return
    event.preventDefault()
    splitter.setPointerCapture?.(event.pointerId)
    splitter.classList.add('dragging')
    drag = { y: event.clientY, start: left.querySelector('.wb-presets')?.offsetHeight ?? 170 }
    const move = (moveEvent) => {
      if (drag === null) return
      apply(drag.start - (moveEvent.clientY - drag.y))
    }
    const stop = () => {
      drag = null
      splitter.classList.remove('dragging')
      splitter.removeEventListener('pointermove', move)
      splitter.removeEventListener('pointerup', stop)
      splitter.removeEventListener('pointercancel', stop)
    }
    splitter.addEventListener('pointermove', move)
    splitter.addEventListener('pointerup', stop)
    splitter.addEventListener('pointercancel', stop)
  })
}

/**
 * Preset expressions, edited where the parameter values are visible.
 *
 * A preset pins concrete parameter values (the ones the sliders hold), so it is a
 * pose, not just another emotion vector; it lives in the workbench for that reason.
 * The id becomes usable as `live2d_act`'s `emotion`.
 */
function mountWorkbenchPresets(rows, touched) {
  const block = el('div', { class: 'wb-presets' })
  block.append(el('h4', { text: '预设表情' }))
  const status = el('p', { class: 'wb-hint', text: '读取中…' })
  const body = el('div', { class: 'wb-preset-list' })
  const id = el('input', { type: 'text', placeholder: 'id，如 smirk', title: '给模型的短 id：之后 live2d_act 的 emotion 直接填它' })
  const label = el('input', { type: 'text', placeholder: '显示名', title: '显示名，会写进提示词的原型列表' })
  const expression = el('select', { title: '模型自己声明过的表情文件；留空则只用参数值' })
  expression.append(el('option', { value: '', text: '（不用表情）' }))
  const capture = el('button', {
    type: 'button',
    text: '把当前参数存为预设',
    title: '只收录你在这台工作台里动过的滑块',
  })
  const row = el('div', { class: 'wb-preset-new' })
  row.append(id, label, expression, capture)
  block.append(status, row, body)

  let presets = []
  let expressions = []

  const save = async () => {
    try {
      await fetchJson(`${API}/presets`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ version: 1, presets }),
      })
      draw()
    } catch (error) {
      status.textContent = `保存失败：${error?.message ?? error}`
    }
  }

  const draw = () => {
    body.replaceChildren()
    if (presets.length === 0) {
      body.append(el('p', {
        class: 'wb-hint',
        text: '还没有预设',
        title: '调好几个滑块，填一个 id，再点「把当前参数存为预设」',
      }))
      return
    }
    for (const [index, preset] of presets.entries()) {
      const line = el('div', { class: 'wb-preset-row' })
      const name = el('span', { class: 'wb-preset-name', text: `${preset.id} · ${preset.label}` })
      const meta = el('span', {
        class: 'wb-preset-meta',
        text: 'i',
        title: `${Object.keys(preset.params ?? {}).length} 个参数${preset.expression ? `，表情 ${preset.expression}` : '，不使用表情'}`,
      })
      const load = el('button', {
        type: 'button',
        text: '载入',
        title: '把这组参数值填回滑块',
        onclick: () => {
          for (const [paramId, value] of Object.entries(preset.params ?? {})) {
            const target = rows.find(entry => entry.id === paramId)
            if (target === undefined) continue
            target.slider.value = String(value)
            target.slider.dispatchEvent(new Event('input'))
          }
          status.textContent = `已载入 ${preset.id}`
        },
      })
      const drop = el('button', {
        type: 'button',
        text: '×',
        title: '删除这条预设',
        onclick: () => {
          presets.splice(index, 1)
          void save()
        },
      })
      line.append(name, meta, load, drop)
      body.append(line)
    }
  }

  const load = async () => {
    const payload = await fetchJson(`${API}/presets`)
    presets = Array.isArray(payload.presets) ? payload.presets : []
    expressions = Array.isArray(payload.expressions) ? payload.expressions : []
    expression.replaceChildren(el('option', { value: '', text: '（不用表情）' }))
    for (const name of expressions) expression.append(el('option', { value: name, text: name }))
    // The list is reference text, not status: it belongs on hover, not in the panel.
    expression.title = expressions.length === 0
      ? '这个模型没有声明表情文件，预设只靠参数值'
      : `模型可用的表情：${expressions.join(' · ')}（只能从这里选，留空则只用参数值）`
    if (presets.length === 0) status.textContent = ''
    draw()
  }

  capture.addEventListener('click', () => {
    const presetId = id.value.trim()
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,23}$/.test(presetId)) {
      status.textContent = 'id 要以字母开头，最多 24 位字母、数字、- 或 _'
      return
    }
    const params = {}
    for (const entry of rows) {
      if (!touched.has(entry.id)) continue
      const value = Number(entry.slider.value)
      if (Number.isFinite(value)) params[entry.id] = value
    }
    if (Object.keys(params).length === 0) {
      status.textContent = '还没动过任何滑块：先调几个参数，再存。'
      return
    }
    const next = {
      id: presetId,
      label: label.value.trim() || presetId,
      expression: expression.value,
      params,
    }
    const at = presets.findIndex(item => item.id === presetId)
    if (at === -1) presets.push(next)
    else presets[at] = next
    void save().then(() => { status.textContent = `已保存 ${presetId}（${Object.keys(params).length} 个参数）` })
  })

  void load().catch((error) => { status.textContent = `读取失败：${error?.message ?? error}` })
  return block
}

/**
 * What the last prompt assembly injected from the world book.
 *
 * Tuning the budget, the scan depth or the cooldown without this is guesswork:
 * the answer only shows up in the reply, long after the decision was made.
 */
function mountWorldbookBlock() {
  const block = el('div', { class: 'block' })
  block.append(el('h3', { text: '世界书诊断' }))
  const head = el('p', { class: 'status', text: '读取中…' })
  const body = el('div', { class: 'wb' })
  const refresh = el('button', {
    type: 'button',
    text: '刷新',
    title: '重新读取世界书的注入结果',
    onclick: async () => {
      refresh.disabled = true
      try {
        await load()
      } finally {
        refresh.disabled = false
      }
    },
  })
  const actions = el('div', { class: 'actions' })
  actions.append(refresh)

  const row = (text, cls) => el('div', { class: cls, text })

  const load = async () => {
    body.textContent = ''
    let data
    try {
      data = await fetchJson(`${API}/worldbook`)
    } catch (error) {
      head.textContent = `读取失败：${error?.message ?? error}`
      return
    }
    const settings = data.settings ?? {}
    const report = data.report
    const budget = settings.budgetTokens ?? 0
    const used = report?.usedTokens ?? 0
    head.textContent = data.pack === null
      ? '没有加载角色包'
      : `词条 ${data.entries} 条 · 预算 ${budget} token · 扫描最近 ${settings.scanDepth ?? '?'} 条 · `
        + `连续命中 2 次后冷却 ${settings.cooldownRounds ?? 0} 轮`
    if (data.pack === null) return
    if (report === null || report === undefined) {
      body.append(row('还没有装配过。发一条消息后再刷新。', 'wbnone'))
      return
    }
    body.append(row(
      `第 ${report.assembly} 次装配 · 扫描 ${report.scannedMessages}/${report.digestMessages} 条消息 · `
        + `注入 ${report.injected.length} 条，用掉 ${used}/${budget} token`,
      'wbsum',
    ))
    const list = (items, cls, format) => {
      for (const item of items) body.append(row(format(item), cls))
    }
    list(report.injected, 'wbin', item => `＋ #${item.id} ${item.comment || '（无备注）'} · ${item.tokens} token`)
    list(report.droppedBudget, 'wbdrop', item => `－ #${item.id} ${item.comment || '（无备注）'} · 预算不够（需 ${item.tokens}）`)
    list(report.droppedConstantBudget, 'wbdrop', item => `－ #${item.id} ${item.comment || '（常驻）'} · 常驻但预算不够（需 ${item.tokens}）`)
    list(report.droppedCooldown, 'wbdrop', item => `－ #${item.id} ${item.comment || '（无备注）'} · 冷却中`)
    list(report.droppedGroup, 'wbdrop', item => `－ #${item.id} ${item.comment || '（无备注）'} · 同组「${item.group}」落选`)
    if (report.matched.length === 0) body.append(row('这一轮没有任何词条被触发（关键词都没出现）。', 'wbnone'))
  }

  void load()
  block.append(head, body, actions)
  return block
}

/** Settings entry point: a button that opens the workbench screen. */
function mountWorkbenchLauncher() {
  const block = el('div', { class: 'block' })
  block.append(el('h3', { text: '参数工作台' }))
  block.append(el('button', {
    class: 'primary',
    text: '打开参数工作台',
    onclick: () => openWorkbench(),
  }))
  return block
}

/** Slot component: a React shell that owns one DOM subtree. */
function SettingsSection() {
  const ref = React.useRef(null)
  React.useEffect(() => {
    const node = ref.current
    if (node === null) return undefined
    // The page no longer floats the stage: moving the canvas to a foreground seat
    // reallocates the renderer at viewport size and again on the way back, which
    // stalled this panel for as long as the GPU took to rebuild its targets. The
    // live preview buttons that needed it are gone.
    S.settingsOpen = true
    const started = performance.now()
    void mountSettingsForm(node).then(() => {
      console.info(`[dsh-live-tavern] settings ready in ${Math.round(performance.now() - started)} ms`)
    })
    return () => {
      node.textContent = ''
      previewBubble(false)
      S.settingsOpen = false
    }
  }, [])
  return React.createElement('div', { ref, className: 'dsh-l2d-set' })
}

/**
 * Register the stage for the lifetime of this client plugin.
 *
 * @param ctx - Client Cordis context.
 * @returns Dispose function removing every seat, observer, canvas and panel.
 */
/**
 * `GET /config`, retried while the Host half is re-registering its routes.
 *
 * Toggling the plugin reloads both halves, and the browser half runs first often
 * enough that a single attempt lands on a 400/404 from the previous registration.
 * Failing to load the character is a nuisance; failing to load the panel is not.
 */
async function fetchConfig() {
  let last
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const config = await fetchJson(`${API}/config`)
      if (config !== null && typeof config === 'object' && config.selected === null && typeof config.error === 'string') {
        throw new Error(config.error)
      }
      return config
    } catch (error) {
      last = error
      await new Promise(resolve => setTimeout(resolve, 250 * (attempt + 1)))
    }
  }
  throw last
}

export async function apply(ctx) {
  if (S.app !== null || S.disposed) return undefined
  try {
    if (S.style === null) {
      S.style = el('style', { id: STYLE_ID, text: CSS })
      document.head.append(S.style)
    }
    // The settings page is registered first: a broken configuration must stay
    // fixable from the GUI even when the stage itself failed to boot.
    if (typeof ctx.slots?.inject === 'function') {
      ctx.effect(() => ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'dsh-live-tavern-lite',
        label: 'Live Tavern',
        order: 40,
      }, SettingsSection)))
    }
    S.config = await fetchConfig()
    S.layout = readLayout()
    // Start the 17 MB download now, in parallel with waiting for the seat, so the
    // mask has real progress to show instead of an idle spinner.
    preloadVrm(S.config)
    // Booting the stage must not hold up the plugin table: the shell may still
    // be mounting, and the layout watcher starts it as soon as it can.
    watchLayout()
    void startEngine().catch((error) => {
      showError(error)
      reportStatus({ ok: false, error: String(error?.stack ?? error) })
    })
  } catch (error) {
    // A 400/404 here is almost always a stale Host half: the browser bundle is
    // re-read from disk on every load, the Host module is not.
    const message = String(error?.message ?? error)
    const stale = /→\s*(400|404)/.test(message)
    showNotice(stale
      ? 'Live2D 宿主还没重启：先重启 dsh web，再打开这个插件。'
      : `Live2D 启动失败：${message}`)
    reportStatus({ ok: false, error: message })
  }
  return () => dispose()
}

function dispose() {
  S.disposed = true
  for (const unwatch of S.observers.splice(0)) {
    try { unwatch() } catch { /* observers are best-effort on teardown */ }
  }
  S.stageSource?.close()
  S.stageSource = null
  if (S.revertTimer !== 0) clearTimeout(S.revertTimer)
  S.revertTimer = 0
  S.bubble?.remove()
  S.bubble = null
  S.dragBox = null
  S.pointerGestures = false
  removeRig()
  if (S.frame !== 0) cancelAnimationFrame(S.frame)
  S.frame = 0
  S.mirrors.clear()
  try {
    S.app?.destroy(true, { children: true })
  } catch (error) {
    console.warn('[dsh-live-tavern] renderer teardown failed', error)
  }
  S.app = null
  disposeVrm()
  S.kind = null
  S.model = null
  for (const entry of S.seats.values()) {
    entry.node?.remove?.()
    if (entry.marker) entry.anchor?.removeAttribute?.('data-dsh-l2d-anchor')
  }
  S.seats.clear()
  S.host.clear()
  S.panel?.remove()
  S.panel = null
  document.querySelector('.dsh-l2d-error')?.remove()
  S.style?.remove()
  S.style = null
  if (window.__dshTavernLite) delete window.__dshTavernLite
}
