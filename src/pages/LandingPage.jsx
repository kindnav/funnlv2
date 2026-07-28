import { useRef, useState, useEffect, useCallback } from 'react' // useCallback used in LandingPage.measure
import { useNavigate, Link } from 'react-router-dom'
import { track } from '../lib/analytics'

// ─── constants ───────────────────────────────────────────────────────────────
const FW = 120, FH = 140
const SENTENCES = [
  'Stop losing track of people.',
  'Remember every conversation.',
  'Know exactly who to follow up with.',
]
const AIQ = "Show me everyone in my network who works in investment banking at Goldman Sachs, prioritized by how overdue my follow-up is and grouped by how we met."

// ─── easing helpers (ported exactly from prototype) ──────────────────────────
function clamp01(x) { return Math.max(0, Math.min(1, x)) }
function lerp(a, b, t) { return a + (b - a) * t }
function easeInOut(t) { return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2 }
function easeOut(t) { return 1 - Math.pow(1 - t, 3) }

// ─── funnel geometry (ported exactly) ────────────────────────────────────────
function funnelGeom(t, nat) {
  const vw = window.innerWidth, vh = window.innerHeight
  const g = easeInOut(clamp01((t - 0.06) / 0.42))
  let smax = Math.max(2.2, Math.min(0.62 * vh / FH, 0.55 * vw / FW))
  if (nat && nat.homeBottom) {
    const cap = (0.6 * vh - nat.homeBottom - 6) / (FH * 0.5)
    smax = Math.max(1.4, Math.min(smax, cap))
  }
  let S = lerp(1, smax, g)
  const sh = easeInOut(clamp01((t - 0.76) / 0.14))
  S = lerp(S, 0.85, sh)
  const topFrac = lerp(0.6, 0.28, sh)
  return { S, topFrac }
}
function mouthY(geo) { return geo.topFrac * window.innerHeight - FH * geo.S * 0.5 }
function spoutY(geo) { return geo.topFrac * window.innerHeight + FH * geo.S * 0.48 }

// ─── NavBar ──────────────────────────────────────────────────────────────────
function NavBar({ scrolled, onStart }) {
  return (
    <nav style={{
      position: 'fixed', top: 0, left: 0, right: 0, zIndex: 50,
      background: scrolled ? 'rgba(20,17,15,0.85)' : 'rgba(20,17,15,0)',
      backdropFilter: scrolled ? 'blur(14px)' : 'none',
      borderBottom: scrolled ? '1px solid rgba(247,242,231,0.08)' : '1px solid transparent',
      transition: 'background .3s ease, border-color .3s ease',
    }}>
      <div style={{ maxWidth: 1240, margin: '0 auto', padding: '0 28px', height: 64, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
          <div style={{ width: 26, height: 26, borderRadius: 7, background: '#FF4423', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none"><path d="M3 4H21L15 12.5V20H9V12.5Z" fill="#14110F"/></svg>
          </div>
          <span style={{ fontFamily: "'Space Grotesk',sans-serif", fontWeight: 700, fontSize: 16, letterSpacing: '-0.2px', color: '#F7F2E7' }}>Funnl</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 26 }}>
          <a href="#timeline" style={{ fontSize: 13, fontWeight: 500, color: '#C7BFAE', textDecoration: 'none' }}>How it works</a>
          <a href="#ai" style={{ fontSize: 13, fontWeight: 500, color: '#C7BFAE', textDecoration: 'none' }}>Funnl AI</a>
          <Link to="/signin" style={{ fontSize: 13, fontWeight: 500, color: '#C7BFAE', textDecoration: 'none' }}>Sign in</Link>
          <NavCTA onStart={onStart} />
        </div>
      </div>
    </nav>
  )
}

function NavCTA({ onStart }) {
  const [hovered, setHovered] = useState(false)
  return (
    <button
      onClick={onStart}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        background: hovered ? '#FFA37A' : '#F7F2E7',
        color: '#14110F', fontSize: 13, fontWeight: 700,
        border: 0, borderRadius: 999, padding: '9px 18px', cursor: 'pointer',
        transform: hovered ? 'scale(1.05)' : 'scale(1)',
        transition: 'transform .2s ease, background .2s ease',
      }}
    >Get started</button>
  )
}

// ─── HeroSection (owns its own scroll wrapper + sticky stage) ────────────────
const CARD_DEFS = [
  { name: 'Priya Sharma', role: 'Goldman Sachs', initials: 'PS', tag: 'recruiter', grad: 'linear-gradient(135deg,#FF6A3D,#D6330F)' },
  { name: 'James Kim',    role: 'McKinsey & Co', initials: 'JK', tag: 'alumni',    grad: 'linear-gradient(135deg,#E8A93B,#A56A00)' },
  { name: 'Dana Ruiz',    role: 'Sequoia Capital',initials: 'DR', tag: 'club',      grad: 'linear-gradient(135deg,#4F9A73,#2E7D5B)' },
]

// HeroInner renders just the content inside the sticky viewport
function HeroSection({ t, nat, reduced }) {
  const geo = funnelGeom(t, nat)
  const vh = typeof window !== 'undefined' ? window.innerHeight : 800

  // funnel transform
  let pulse = 0
  for (let i = 0; i < 5; i++) {
    const wStart = 0.14 + i * 0.09, wDur = 0.26
    const d = Math.abs(t - (wStart + wDur * 0.55))
    pulse = Math.max(pulse, Math.max(0, 1 - d / 0.04))
  }
  const funnelTransform = `translate(-50%,-50%) scale(${geo.S * (1 + 0.05 * pulse)},${geo.S * (1 - 0.04 * pulse)})`
  const glow = clamp01(t / 0.7)
  const glowPx = lerp(8, 40, glow)
  const glowA  = lerp(0.2, 0.45, glow)

  // clip path bottom value: clips letters at funnel top edge
  const clipBottom = reduced ? 0 : Math.max(0, vh - mouthY(geo))

  // tagline
  const tagT = clamp01((t - 0.86) / 0.12)
  const tagOpacity = reduced ? 1 : tagT
  const tagTY = lerp(20, 0, tagT)

  // intro block fade
  const introOpacity = reduced ? 1 : lerp(1, 0, clamp01(t / 0.08))

  return (
    <>
        {/* tagline */}
        <h2 style={{
          position: 'absolute', top: '46%', left: 0, width: '100%',
          textAlign: 'center', margin: 0,
          fontFamily: "'Space Grotesk',sans-serif", fontWeight: 700,
          fontSize: 'clamp(22px,3.5vw,42px)', letterSpacing: '-1.5px',
          color: '#F7F2E7', zIndex: 5, padding: '0 20px', boxSizing: 'border-box',
          opacity: tagOpacity,
          transform: `translateY(${tagTY}px)`,
        }}>Ditch the clunky spreadsheets and barbaric documents.</h2>

        {/* funnel mark */}
        <div style={{
          position: 'absolute', left: '50%', top: `${geo.topFrac * 100}%`,
          width: FW, height: FH,
          transform: funnelTransform,
          filter: `drop-shadow(0 0 ${glowPx}px rgba(255,68,35,${glowA}))`,
          zIndex: 2, willChange: 'transform', pointerEvents: 'none',
        }}>
          <div style={{
            position: 'absolute', inset: 0, background: '#FF4423',
            clipPath: 'polygon(0% 0%,100% 0%,62% 58%,62% 100%,38% 100%,38% 58%)',
          }} />
        </div>

        {/* letters layer — clipped at funnel top edge */}
        <div style={{
          position: 'absolute', inset: 0, zIndex: 3, pointerEvents: 'none',
          clipPath: reduced ? 'none' : `inset(0px 0px ${clipBottom}px 0px)`,
        }}>
          <div data-letters style={{ position: 'absolute', top: '12%', left: 0, width: '100%', display: 'flex', justifyContent: 'center', gap: '0.02em' }}>
            {'FUNNL'.split('').map((ch, i) => (
              <HeroLetter key={i} ch={ch} idx={i} t={t} nat={nat} geo={geo} reduced={reduced} />
            ))}
          </div>
        </div>

        {/* contact cards */}
        <div data-cards style={{
          position: 'absolute', top: '70%', left: 0, width: '100%',
          display: 'flex', justifyContent: 'center', gap: 16, zIndex: 2,
          flexWrap: 'wrap', padding: '0 16px', boxSizing: 'border-box',
        }}>
          {CARD_DEFS.map((c, j) => (
            <HeroCard key={j} card={c} j={j} t={t} nat={nat} geo={geo} reduced={reduced} />
          ))}
        </div>

        {/* intro block */}
        <div style={{
          position: 'absolute', bottom: '6%', left: 0, width: '100%',
          display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14,
          opacity: introOpacity, zIndex: 5,
        }}>
          <span style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 11, color: '#FF6A3D', letterSpacing: 1.5, textTransform: 'uppercase' }}>Networking, organized</span>
          <p style={{ fontSize: 16, color: '#C7BFAE', margin: 0, maxWidth: 420, lineHeight: 1.55, textAlign: 'center' }}>Meet people. Remember everything. Follow through.</p>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, marginTop: 10 }}>
            <span style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 10, color: '#6B655C', letterSpacing: 1 }}>SCROLL</span>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#6B655C" strokeWidth="2" style={{ animation: 'chevronBob 1.6s ease-in-out infinite' }}><path d="M12 5v14M5 12l7 7 7-7"/></svg>
          </div>
        </div>
    </>
  )
}

function HeroLetter({ ch, idx, t, nat, geo, reduced }) {
  const vh = window.innerHeight
  const wStart = 0.14 + idx * 0.09, wDur = 0.26
  const lt = clamp01((t - wStart) / wDur)
  const fall = clamp01(lt / 0.6)
  const dive = clamp01((lt - 0.6) / 0.4)
  const e = Math.pow(fall, 1.6)

  let tx = 0, ty = lerp(0, vh * 0.3, e)
  if (nat && nat.letters[idx]) {
    const n = nat.letters[idx]
    tx = (window.innerWidth / 2 - n.x) * e
    ty = (mouthY(geo) - n.y) * e
  }
  ty += easeOut(dive) * Math.max(180, FH * geo.S * 0.35)
  const rot = (idx % 2 === 0 ? 1 : -1) * 16 * e * (1 - dive)
  const scale = lerp(1, 0.5, e)
  const opacity = reduced ? 0 : (lt >= 1 ? 0 : 1)

  return (
    <span data-fl={idx} style={{
      display: 'inline-block',
      fontFamily: "'Space Grotesk',sans-serif", fontWeight: 700,
      fontSize: 'min(18vw,190px)', lineHeight: 0.85, letterSpacing: '-6px',
      color: '#F7F2E7',
      transform: `translate(${tx}px,${ty}px) rotate(${rot}deg) scale(${scale})`,
      opacity, willChange: 'transform',
    }}>{ch}</span>
  )
}

function HeroCard({ card, j, t, nat, geo, reduced }) {
  const wStart = 0.76 + j * 0.055, wDur = 0.13
  const lt = clamp01((t - wStart) / wDur)
  const e = easeOut(lt)
  let tx = 0, ty = (1 - e) * -120
  if (nat && nat.cards[j]) {
    const n = nat.cards[j]
    tx = (window.innerWidth / 2 - n.x) * (1 - e)
    ty = (spoutY(geo) + 10 - n.y) * (1 - e)
  }
  const opacity = reduced ? 1 : clamp01(lt * 2.5)

  return (
    <div data-fc={j} style={{
      display: 'flex', alignItems: 'center', gap: 10,
      background: '#F7F2E7', borderRadius: 14, padding: '12px 16px',
      boxShadow: '0 16px 40px rgba(0,0,0,0.45)',
      opacity,
      transform: `translate(${tx}px,${ty}px) scale(${lerp(0.55, 1, e)})`,
      willChange: 'transform,opacity',
    }}>
      <div style={{
        width: 34, height: 34, borderRadius: 9, background: card.grad,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontFamily: "'Space Grotesk',sans-serif", fontWeight: 700,
        fontSize: 11.5, color: '#F7F2E7', flexShrink: 0,
      }}>{card.initials}</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
        <span style={{ fontSize: 13, fontWeight: 600, color: '#14110F', whiteSpace: 'nowrap' }}>{card.name}</span>
        <span style={{ fontSize: 11, color: '#6B655C', whiteSpace: 'nowrap' }}>{card.role}</span>
      </div>
      <span style={{
        fontFamily: "'JetBrains Mono',monospace", fontSize: 9, color: '#D6330F',
        border: '1px solid rgba(214,51,15,0.35)', borderRadius: 999,
        padding: '3px 8px', flexShrink: 0, marginLeft: 4,
      }}>{card.tag}</span>
    </div>
  )
}

// ─── TypedSection ─────────────────────────────────────────────────────────────
function TypedSection({ reduced }) {
  const ref = useRef(null)
  const [text, setText] = useState('')
  const started = useRef(false)
  const timers = useRef([])
  const setTextRef = useRef(setText)
  setTextRef.current = setText

  useEffect(() => {
    if (reduced) { setText(SENTENCES[2]); return }

    function later(fn, ms) { const id = setTimeout(fn, ms); timers.current.push(id) }
    function runTyped(si) {
      const str = SENTENCES[si]; let n = 0
      function typeNext() {
        n++; setTextRef.current(str.slice(0, n))
        if (n < str.length) later(typeNext, 52)
        else later(() => deleteTyped(si), 1600)
      }
      typeNext()
    }
    function deleteTyped(si) {
      const str = SENTENCES[si]; let n = str.length
      function delNext() {
        n--; setTextRef.current(str.slice(0, n))
        if (n > 0) later(delNext, 24)
        else later(() => runTyped((si + 1) % SENTENCES.length), 350)
      }
      delNext()
    }

    const io = new IntersectionObserver(entries => {
      if (entries[0].isIntersecting && !started.current) {
        started.current = true
        runTyped(0)
        io.disconnect()
      }
    }, { threshold: 0.45 })
    if (ref.current) io.observe(ref.current)
    const t = timers.current
    return () => { io.disconnect(); t.forEach(clearTimeout) }
  }, [reduced])

  return (
    <section ref={ref} style={{
      position: 'relative', minHeight: '100vh',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      overflow: 'hidden', background: '#14110F',
    }}>
      <span style={{
        position: 'absolute', top: '50%', left: '50%',
        transform: 'translate(-50%,-50%)',
        fontFamily: "'Space Grotesk',sans-serif", fontWeight: 700,
        fontSize: '34vw', letterSpacing: '-1.5vw',
        color: 'rgba(247,242,231,0.05)', filter: 'blur(5px)',
        whiteSpace: 'nowrap', pointerEvents: 'none', userSelect: 'none',
      }}>FUNNL</span>
      <p style={{
        position: 'relative',
        fontFamily: "'Space Grotesk',sans-serif", fontWeight: 700,
        fontSize: 'clamp(30px,5.5vw,72px)', letterSpacing: '-2px',
        color: '#F7F2E7', margin: 0, textAlign: 'center',
        maxWidth: 1000, padding: '0 24px', lineHeight: 1.08,
        minHeight: '2.2em',
      }}>
        {text}
        <span style={{
          display: 'inline-block', width: '0.08em', height: '0.9em',
          background: '#FF4423', verticalAlign: '-0.1em', marginLeft: 6,
          animation: 'caretBlink 0.9s step-end infinite',
        }} />
      </p>
    </section>
  )
}

// ─── reveal hook ─────────────────────────────────────────────────────────────
function useReveal(reduced) {
  const ref = useRef(null)
  const [revealed, setRevealed] = useState(false)
  useEffect(() => {
    if (reduced) { setRevealed(true); return }
    const io = new IntersectionObserver(entries => {
      if (entries[0].isIntersecting) { setRevealed(true); io.disconnect() }
    }, { threshold: 0.45 })
    if (ref.current) io.observe(ref.current)
    return () => io.disconnect()
  }, [reduced])
  return [ref, revealed]
}

// ─── TimelineSection ──────────────────────────────────────────────────────────
function TimelineSection({ reduced }) {
  const [ref, revealed] = useReveal(reduced)
  const rv = revealed ? '1' : '0'
  const base = {
    opacity: rv === '0' ? 0 : 1,
    transform: rv === '0' ? 'translateY(34px)' : 'none',
    transition: 'opacity .8s cubic-bezier(.22,1,.36,1), transform .8s cubic-bezier(.22,1,.36,1)',
  }
  const r = (delay) => ({ ...base, transitionDelay: delay })

  return (
    <section id="timeline" ref={ref} style={{
      position: 'relative', minHeight: '100vh',
      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      padding: '140px 24px', background: '#0F0D0B',
    }}>
      <span style={{ ...r('0s'), fontFamily: "'JetBrains Mono',monospace", fontSize: 11, color: '#FF6A3D', letterSpacing: 2, textTransform: 'uppercase', marginBottom: 20 }}>Every interaction, remembered</span>
      <h2 style={{ ...r('.12s'), fontFamily: "'Space Grotesk',sans-serif", fontWeight: 700, fontSize: 'clamp(38px,6.5vw,80px)', letterSpacing: '-2.5px', textAlign: 'center', margin: '0 0 56px', lineHeight: 1.0, color: '#F7F2E7' }}>The conversation,<br/>not just the name.</h2>
      <div style={{ ...r('.24s'), maxWidth: 560, width: '100%', background: '#1C1815', border: '1px solid rgba(247,242,231,0.08)', borderRadius: 22, padding: 32, boxShadow: '0 40px 100px rgba(0,0,0,0.5)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 26 }}>
          <div style={{ width: 44, height: 44, borderRadius: 12, background: 'linear-gradient(135deg,#FF6A3D,#D6330F)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: "'Space Grotesk',sans-serif", fontWeight: 700, fontSize: 14, color: '#14110F', flexShrink: 0 }}>PS</div>
          <div style={{ flex: 1 }}>
            <p style={{ margin: 0, fontWeight: 600, fontSize: 15, color: '#F7F2E7' }}>Priya Sharma</p>
            <p style={{ margin: 0, fontSize: 12, color: '#6B655C' }}>Analyst · Goldman Sachs</p>
          </div>
          <span style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 9.5, color: '#FF6A3D', letterSpacing: 1 }}>RECRUITER</span>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          <TlRow delay=".12s" rv={rv} label="MAY 3 · MET" labelColor="#6B655C" text="IU finance club panel — intro after her talk." textColor="#C7BFAE" border />
          <TlRow delay=".24s" rv={rv} label="JUN 8 · COFFEE CHAT" labelColor="#6B655C" text="Analyst program still has open slots." textColor="#C7BFAE" border />
          <TlRow delay=".36s" rv={rv} label="JUL 22 · FOLLOW UP" labelColor="#E8A93B" labelBold text="Ask about second-round timing." textColor="#F7F2E7" />
        </div>
      </div>
    </section>
  )
}

function TlRow({ delay, rv, label, labelColor, labelBold, text, textColor, border }) {
  const base = {
    opacity: rv === '0' ? 0 : 1,
    transform: rv === '0' ? 'translateY(34px)' : 'none',
    transition: `opacity .8s cubic-bezier(.22,1,.36,1) ${delay}, transform .8s cubic-bezier(.22,1,.36,1) ${delay}`,
  }
  return (
    <div style={{ ...base, display: 'flex', gap: 14, paddingBottom: border ? 22 : 0, borderLeft: '2px solid rgba(255,106,61,0.35)', paddingLeft: 18, marginLeft: 6 }}>
      <div>
        <span style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 10, color: labelColor, fontWeight: labelBold ? 600 : 400 }}>{label}</span>
        <p style={{ margin: '4px 0 0', fontSize: 13.5, color: textColor }}>{text}</p>
      </div>
    </div>
  )
}

// ─── PrioritySection ──────────────────────────────────────────────────────────
const PRIORITY_ROWS = [
  { name: 'James Kim',   status: '2 DAYS OVERDUE',     color: '#E85D75', bg: 'rgba(232,93,117,0.1)',  border: 'rgba(232,93,117,0.35)' },
  { name: 'Priya Sharma',status: 'FOLLOW UP TODAY',    color: '#E8A93B', bg: 'rgba(232,169,59,0.08)', border: 'rgba(232,169,59,0.3)' },
  { name: 'Marcus Lee',  status: 'AWAITING RESPONSE',  color: '#C7A96B', bg: 'rgba(232,169,59,0.05)', border: 'rgba(232,169,59,0.18)' },
  { name: 'Alex Chen',   status: 'RESPONDED JUL 4',    color: '#4F9A73', bg: 'rgba(79,154,115,0.07)', border: 'rgba(79,154,115,0.22)', opacity: 0.9 },
]
const DOT_COLORS = ['#E85D75','#E8A93B','#E8A93B','#4F9A73']
const DOT_OPACITIES = [1,1,0.6,1]

function PrioritySection({ reduced }) {
  const [ref, revealed] = useReveal(reduced)
  const rv = revealed ? '1' : '0'
  const base = (delay) => ({
    opacity: rv === '0' ? 0 : 1,
    transform: rv === '0' ? 'translateY(34px)' : 'none',
    transition: `opacity .8s cubic-bezier(.22,1,.36,1) ${delay}, transform .8s cubic-bezier(.22,1,.36,1) ${delay}`,
  })
  return (
    <section id="priority" ref={ref} style={{ position: 'relative', minHeight: '100vh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '140px 24px', background: '#14110F' }}>
      <span style={{ ...base('0s'), fontFamily: "'JetBrains Mono',monospace", fontSize: 11, color: '#FF6A3D', letterSpacing: 2, textTransform: 'uppercase', marginBottom: 20 }}>Follow-ups, sorted</span>
      <h2 style={{ ...base('.12s'), fontFamily: "'Space Grotesk',sans-serif", fontWeight: 700, fontSize: 'clamp(38px,6.5vw,80px)', letterSpacing: '-2.5px', textAlign: 'center', margin: '0 0 56px', lineHeight: 1.0, color: '#F7F2E7' }}>Always know<br/>who's next.</h2>
      <div style={{ ...base('.24s'), maxWidth: 520, width: '100%', display: 'flex', flexDirection: 'column', gap: 10 }}>
        {PRIORITY_ROWS.map((row, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 12, background: row.bg, border: `1px solid ${row.border}`, borderRadius: 12, padding: '16px 20px', opacity: row.opacity ?? 1 }}>
            <span style={{ width: 8, height: 8, borderRadius: '50%', background: DOT_COLORS[i], flexShrink: 0, opacity: DOT_OPACITIES[i] }} />
            <div style={{ flex: 1 }}><p style={{ margin: 0, fontSize: 14, fontWeight: 600, color: '#F7F2E7' }}>{row.name}</p></div>
            <span style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 10.5, color: row.color, fontWeight: 600 }}>{row.status}</span>
          </div>
        ))}
      </div>
    </section>
  )
}

// ─── AISection ────────────────────────────────────────────────────────────────
const AIQ_WORDS = AIQ.split(' ')

function AISection({ reduced }) {
  const ref = useRef(null)
  const [revealed, setRevealed] = useState(false)
  const [aiWords, setAiWords] = useState(0)
  const [aiDone, setAiDone] = useState(false)
  const started = useRef(false)
  const timers = useRef([])
  const later = (fn, ms) => { const id = setTimeout(fn, ms); timers.current.push(id) }

  useEffect(() => {
    if (reduced) { setRevealed(true); setAiWords(AIQ_WORDS.length); setAiDone(true); return }
    const io = new IntersectionObserver(entries => {
      if (entries[0].isIntersecting) {
        setRevealed(true)
        if (!started.current) {
          started.current = true
          let n = 0
          const next = () => {
            n++
            setAiWords(n)
            if (n < AIQ_WORDS.length) later(next, 60)
            else later(() => setAiDone(true), 500)
          }
          later(next, 500)
        }
        io.disconnect()
      }
    }, { threshold: 0.45 })
    if (ref.current) io.observe(ref.current)
    const t = timers.current
    return () => { io.disconnect(); t.forEach(clearTimeout) }
  }, [reduced]) // eslint-disable-line react-hooks/exhaustive-deps

  const rv = revealed ? '1' : '0'
  const baseR = (delay) => ({
    opacity: rv === '0' ? 0 : 1,
    transform: rv === '0' ? 'translateY(34px)' : 'none',
    transition: `opacity .8s cubic-bezier(.22,1,.36,1) ${delay}, transform .8s cubic-bezier(.22,1,.36,1) ${delay}`,
  })
  const baseA = (delay) => ({
    opacity: aiDone || reduced ? 1 : 0,
    transform: aiDone || reduced ? 'none' : 'translateY(18px)',
    transition: `opacity .7s ease ${delay}, transform .7s cubic-bezier(.22,1,.36,1) ${delay}`,
  })

  const chipStyle = { fontFamily: "'JetBrains Mono',monospace", fontSize: 8.5, color: '#52504B', background: 'rgba(20,17,15,0.06)', borderRadius: 4, padding: '2px 7px' }
  const chipGreen = { fontFamily: "'JetBrains Mono',monospace", fontSize: 8.5, color: '#2E7D5B', background: 'rgba(46,125,91,0.12)', borderRadius: 4, padding: '2px 7px' }
  const chipWarn  = { fontFamily: "'JetBrains Mono',monospace", fontSize: 8.5, color: '#A56A00', background: 'rgba(232,169,59,0.15)', borderRadius: 4, padding: '2px 7px' }

  const isMobile = typeof window !== 'undefined' && window.innerWidth < 768

  return (
    <section id="ai" ref={ref} style={{ position: 'relative', minHeight: '100vh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '120px 24px', background: '#F7F2E7', color: '#14110F' }}>
      <span style={{ ...baseR('0s'), fontFamily: "'JetBrains Mono',monospace", fontSize: 11, color: '#D6330F', letterSpacing: 2, textTransform: 'uppercase', marginBottom: 20 }}>Funnl AI</span>
      <h2 style={{ ...baseR('.12s'), fontFamily: "'Space Grotesk',sans-serif", fontWeight: 700, fontSize: 'clamp(38px,6.5vw,80px)', letterSpacing: '-2.5px', textAlign: 'center', margin: '0 0 52px', lineHeight: 1.0, color: '#14110F' }}>Ask your network<br/>anything.</h2>
      <div style={{ ...baseR('.24s'), width: '100%', maxWidth: 1100, aspectRatio: '16/10', background: '#14110F', borderRadius: 18, padding: 'clamp(8px,1.2vw,14px)', boxShadow: '0 50px 120px rgba(20,17,15,0.4)', boxSizing: 'border-box' }}>
        <div style={{ width: '100%', height: '100%', background: '#F7F2E7', borderRadius: 10, display: 'flex', overflow: 'hidden' }}>
          {/* sidebar */}
          {!isMobile && (
            <div style={{ width: 168, background: '#EFE9DC', borderRight: '1px solid rgba(20,17,15,0.07)', display: 'flex', flexDirection: 'column', flexShrink: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '16px 16px 20px' }}>
                <div style={{ width: 20, height: 20, borderRadius: 6, background: '#FF4423', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none"><path d="M3 4H21L15 12.5V20H9V12.5Z" fill="#F7F2E7"/></svg>
                </div>
                <span style={{ fontFamily: "'Space Grotesk',sans-serif", fontWeight: 700, fontSize: 13, color: '#14110F' }}>Funnl</span>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2, padding: '0 10px' }}>
                {['Dashboard','Contacts','Follow-ups'].map(item => (
                  <span key={item} style={{ fontSize: 12.5, color: '#6B655C', padding: '8px 10px', borderRadius: 8 }}>{item}</span>
                ))}
                <span style={{ fontSize: 12.5, color: '#F7F2E7', background: '#FF4423', fontWeight: 600, padding: '8px 10px', borderRadius: 8 }}>Funnl AI</span>
              </div>
            </div>
          )}
          {/* main */}
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 20px', borderBottom: '1px solid rgba(20,17,15,0.08)' }}>
              <span style={{ fontFamily: "'Space Grotesk',sans-serif", fontWeight: 700, fontSize: 13, color: '#14110F' }}>Funnl AI</span>
              <span style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 8.5, color: '#F7F2E7', background: '#14110F', borderRadius: 4, padding: '2px 6px' }}>PRO</span>
            </div>
            <div style={{ flex: 1, padding: 'clamp(14px,2vw,24px)', display: 'flex', flexDirection: 'column', gap: 14, overflow: 'hidden' }}>
              {/* question bubble */}
              <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                <div style={{ background: '#FF4423', color: '#F7F2E7', fontSize: 12.5, fontWeight: 500, lineHeight: 1.5, padding: '12px 16px', borderRadius: '14px 14px 3px 14px', maxWidth: '78%', minHeight: '1.3em' }}>
                  {AIQ_WORDS.slice(0, aiWords).join(' ')}
                  {!aiDone && aiWords > 0 && (
                    <span style={{ display: 'inline-block', width: 2, height: '1em', background: '#F7F2E7', verticalAlign: '-0.15em', marginLeft: 3 }} />
                  )}
                </div>
              </div>
              {/* status line */}
              <div style={{ ...baseA('0s'), fontFamily: "'JetBrains Mono',monospace", fontSize: 10.5, color: '#6B655C' }}>SEARCHING 34 CONTACTS · 5 AT GOLDMAN SACHS · GROUPING BY HOW YOU MET…</div>
              {/* group card 1 */}
              <div style={{ ...baseA('.3s'), background: '#FFFFFF', border: '1px solid rgba(20,17,15,0.08)', borderRadius: 12, padding: '13px 16px', boxShadow: '0 4px 14px rgba(20,17,15,0.04)' }}>
                <p style={{ margin: '0 0 8px', fontFamily: "'JetBrains Mono',monospace", fontSize: 9, color: '#6B655C', letterSpacing: 1 }}>MET AT CAMPUS EVENTS</p>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 13, fontWeight: 600, color: '#14110F' }}>Alex Rivera</span>
                  <span style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 8.5, color: '#F7F2E7', background: '#D6330F', borderRadius: 4, padding: '2px 7px' }}>6 DAYS OVERDUE</span>
                  <span style={chipStyle}>IB analyst</span>
                  <span style={chipStyle}>IU finance panel</span>
                  <span style={chipGreen}>responded ✓</span>
                </div>
                <p style={{ margin: '8px 0 0', fontSize: 12, color: '#52504B' }}>Reply to his June note and ask for a 15-minute call before applications open.</p>
              </div>
              {/* group card 2 */}
              <div style={{ ...baseA('.9s'), background: '#FFFFFF', border: '1px solid rgba(20,17,15,0.08)', borderRadius: 12, padding: '13px 16px', boxShadow: '0 4px 14px rgba(20,17,15,0.04)' }}>
                <p style={{ margin: '0 0 8px', fontFamily: "'JetBrains Mono',monospace", fontSize: 9, color: '#6B655C', letterSpacing: 1 }}>ALUMNI INTROS</p>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 13, fontWeight: 600, color: '#14110F' }}>Priya Sharma</span>
                  <span style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 8.5, color: '#14110F', background: '#E8A93B', borderRadius: 4, padding: '2px 7px' }}>DUE TODAY</span>
                  <span style={chipStyle}>IB associate</span>
                  <span style={chipStyle}>coffee chat Jun 8</span>
                  <span style={chipWarn}>awaiting response</span>
                </div>
                <p style={{ margin: '8px 0 0', fontSize: 12, color: '#52504B' }}>Follow up on second-round timing from your June coffee chat.</p>
              </div>
              {/* group card 3 */}
              <div style={{ ...baseA('1.5s'), background: '#FFFFFF', border: '1px solid rgba(20,17,15,0.08)', borderRadius: 12, padding: '13px 16px', boxShadow: '0 4px 14px rgba(20,17,15,0.04)' }}>
                <p style={{ margin: '0 0 8px', fontFamily: "'JetBrains Mono',monospace", fontSize: 9, color: '#6B655C', letterSpacing: 1 }}>CLUB CONNECTIONS</p>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 13, fontWeight: 600, color: '#14110F' }}>Marcus Lee</span>
                  <span style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 8.5, color: '#F7F2E7', background: '#6B655C', borderRadius: 4, padding: '2px 7px' }}>NO DATE SET</span>
                  <span style={chipStyle}>IB VP</span>
                  <span style={chipStyle}>last spoke 41d</span>
                  <span style={chipWarn}>no follow-up set</span>
                </div>
                <p style={{ margin: '8px 0 0', fontSize: 12, color: '#52504B' }}>Set a follow-up date and reconnect before recruiting season starts.</p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}

// ─── CTASection ───────────────────────────────────────────────────────────────
function CTASection({ onStart, reduced }) {
  const [ref, revealed] = useReveal(reduced)
  const rv = revealed ? '1' : '0'
  const r = (delay) => ({
    opacity: rv === '0' ? 0 : 1,
    transform: rv === '0' ? 'translateY(34px)' : 'none',
    transition: `opacity .8s cubic-bezier(.22,1,.36,1) ${delay}, transform .8s cubic-bezier(.22,1,.36,1) ${delay}`,
  })
  const [hovP, setHovP] = useState(false)
  const [hovS, setHovS] = useState(false)

  return (
    <section id="cta" ref={ref} style={{ position: 'relative', minHeight: '100vh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '120px 24px', background: '#14110F' }}>
      <div style={{ ...r('0s'), position: 'relative', width: 100, height: 118, marginBottom: 30, filter: 'drop-shadow(0 0 28px rgba(255,68,35,0.4))' }}>
        <div style={{ position: 'absolute', inset: 0, background: 'conic-gradient(from 180deg,#FF4423,#D6330F,#FF4423)', clipPath: 'polygon(0% 0%,100% 0%,62% 58%,62% 100%,38% 100%,38% 58%)' }} />
      </div>
      <h2 style={{ ...r('.12s'), fontFamily: "'Space Grotesk',sans-serif", fontWeight: 700, fontSize: 'clamp(34px,6vw,72px)', letterSpacing: '-2.5px', textAlign: 'center', margin: '0 0 26px', maxWidth: 800, lineHeight: 1.02, color: '#F7F2E7' }}>Build the network<br/>that builds your career.</h2>
      <div style={{ ...r('.24s'), display: 'flex', gap: 16, flexWrap: 'wrap', justifyContent: 'center' }}>
        <button
          onClick={onStart}
          onMouseEnter={() => setHovP(true)} onMouseLeave={() => setHovP(false)}
          style={{ background: '#FF4423', color: '#14110F', fontSize: 14.5, fontWeight: 700, border: 0, borderRadius: 10, padding: '16px 30px', cursor: 'pointer', transform: hovP ? 'scale(1.04)' : 'scale(1)', transition: 'transform .2s ease' }}
        >Start building your Funnl</button>
        <button
          onClick={() => document.getElementById('timeline')?.scrollIntoView({ behavior: 'smooth' })}
          onMouseEnter={() => setHovS(true)} onMouseLeave={() => setHovS(false)}
          style={{ background: 'transparent', color: '#F7F2E7', fontSize: 14.5, fontWeight: 600, border: `1px solid ${hovS ? 'rgba(247,242,231,0.5)' : 'rgba(247,242,231,0.25)'}`, borderRadius: 10, padding: '16px 30px', cursor: 'pointer', transform: hovS ? 'scale(1.04)' : 'scale(1)', transition: 'transform .2s ease, border-color .2s ease' }}
        >See how it works</button>
      </div>
      <p style={{ ...r('.36s'), fontSize: 12.5, color: '#6B655C', marginTop: 24 }}>Free to start · No credit card · 2 minutes to your first contact</p>
    </section>
  )
}

// ─── Footer ───────────────────────────────────────────────────────────────────
function Footer() {
  return (
    <footer style={{ borderTop: '1px solid rgba(247,242,231,0.08)' }}>
      <div style={{ maxWidth: 1240, margin: '0 auto', padding: '24px 28px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 12.5, color: '#6B655C' }}>© 2026 Funnl</span>
        <Link to="/privacy" style={{ fontSize: 12.5, color: '#6B655C', textDecoration: 'none' }}>Privacy Policy</Link>
      </div>
    </footer>
  )
}

// ─── LandingPage (root) ───────────────────────────────────────────────────────
export default function LandingPage() {
  const navigate = useNavigate()
  const [progress, setProgress] = useState(0)
  const [navScrolled, setNavScrolled] = useState(false)
  const [reduced, setReduced] = useState(false)
  const [isMobile, setIsMobile] = useState(false)
  const heroRef = useRef(null)
  const natRef = useRef(null)
  const rafRef = useRef(null)

  function handleStart() {
    track('landing_cta_clicked', { location: 'bottom' })
    navigate('/signup')
  }
  function handleNavStart() {
    track('landing_cta_clicked', { location: 'nav' })
    navigate('/signup')
  }

  const measure = useCallback(() => {
    if (progress > 0.05) return
    const letterEls = Array.from(document.querySelectorAll('[data-fl]'))
    const cardEls   = Array.from(document.querySelectorAll('[data-fc]'))
    if (letterEls.length < 5) return
    natRef.current = {
      letters: letterEls.map(el => { const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 } }),
      cards:   cardEls.map(el =>   { const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 } }),
      homeBottom: Math.max(...letterEls.map(el => el.getBoundingClientRect().bottom)),
    }
  }, [progress])

  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
    setReduced(mq.matches)
    setIsMobile(window.innerWidth < 768)
    if (mq.matches) return

    const onScroll = () => {
      if (rafRef.current) return
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null
        const el = heroRef.current
        if (el) {
          const rect = el.getBoundingClientRect()
          const total = rect.height - window.innerHeight
          const t = total > 0 ? Math.max(0, Math.min(1, -rect.top / total)) : 0
          setProgress(t)
          setNavScrolled(window.scrollY > 40)
        }
      })
    }
    const onResize = () => {
      setIsMobile(window.innerWidth < 768)
      measure()
    }

    window.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener('resize', onResize)
    requestAnimationFrame(() => { measure(); onScroll() })

    return () => {
      window.removeEventListener('scroll', onScroll)
      window.removeEventListener('resize', onResize)
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
    }
  }, [measure])

  // re-measure after first render so nat is populated
  useEffect(() => { measure() }, [measure])

  return (
    <div style={{ background: '#14110F', fontFamily: "'Plus Jakarta Sans',sans-serif", color: '#F7F2E7', overflow: 'clip' }}>
      <style>{`
        @keyframes chevronBob { 0%,100%{transform:translateY(0)} 50%{transform:translateY(6px)} }
        @keyframes caretBlink { 0%,49%{opacity:1} 50%,100%{opacity:0} }
        a { color: #FF6A3D; text-decoration: none; }
        a:hover { color: #FFA37A; }
        ::selection { background: #FF4423; color: #14110F; }
        html { scroll-behavior: smooth; }
        @media (prefers-reduced-motion: reduce) {
          [data-hero-anim] { transition: none !important; }
        }
      `}</style>

      <NavBar scrolled={navScrolled} onStart={handleNavStart} />

      {/* Hero scroll wrapper — heroRef measures scroll progress */}
      <div ref={heroRef} style={{ position: 'relative', height: reduced ? 'auto' : (isMobile ? '300vh' : '520vh') }}>
        <div style={{
          position: reduced ? 'relative' : 'sticky', top: 0,
          height: reduced ? 'auto' : '100vh', minHeight: '100vh',
          width: '100%', overflow: 'hidden', boxSizing: 'border-box',
        }}>
          <HeroSection t={progress} nat={natRef.current} reduced={reduced} />
        </div>
      </div>

      <TypedSection reduced={reduced} />
      <TimelineSection reduced={reduced} />
      <PrioritySection reduced={reduced} />
      <AISection reduced={reduced} />
      <CTASection onStart={handleStart} reduced={reduced} />
      <Footer />
    </div>
  )
}
