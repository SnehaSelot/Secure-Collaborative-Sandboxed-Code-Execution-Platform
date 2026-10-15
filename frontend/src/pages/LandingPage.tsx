import { Link } from 'react-router-dom';
import { useAuthStore } from '../state/authStore';
import {
  ArrowRight,
  BrainCircuit,
  Check,
  ChevronRight,
  CirclePlay,
  FileCode2,
  LockKeyhole,
  Network,
  Shield,
  UsersRound,
  Zap,
} from 'lucide-react';

const features = [
  {
    id: 'sandboxed-execution',
    icon: LockKeyhole,
    title: 'Sandboxed Execution',
    description: 'Run untrusted code in isolated Docker containers with configured resource limits.',
  },
  {
    id: 'real-time-collaboration',
    icon: UsersRound,
    title: 'Real-Time Collaboration',
    description: 'Edit shared files together with live synchronization, cursors, and participant presence.',
  },
  {
    id: 'ai-risk-analysis',
    icon: BrainCircuit,
    title: 'AI Risk Analysis',
    description: 'Analyze code for risky patterns with the existing GlassHouse risk-analysis service.',
  },
  {
    id: 'audit-monitoring',
    icon: FileCode2,
    title: 'Audit & Monitoring',
    description: 'Record shared file operations in the collaboration audit trail.',
  },
];

const codeLines = [
  <><span className="text-violet-300">from</span> <span className="text-sky-300">math</span> <span className="text-violet-300">import</span> sqrt</>,
  <span />,
  <><span className="text-violet-300">def</span> <span className="text-sky-200">safe_distance</span>(a, b):</>,
  <>  <span className="text-violet-300">if</span> a &lt; <span className="text-amber-200">0</span> <span className="text-violet-300">or</span> b &lt; <span className="text-amber-200">0</span>:</>,
  <>    <span className="text-violet-300">raise</span> <span className="text-rose-300">ValueError</span>(<span className="text-emerald-200">"values must be positive"</span>)</>,
  <>  <span className="text-violet-300">return</span> sqrt(a * a + b * b)</>,
];

function EditorPreview() {
  return (
    <div className="relative mx-auto w-full max-w-[700px] lg:ml-auto">
      <div className="pointer-events-none absolute -inset-10 rounded-full bg-emerald-400/[0.07] blur-[80px]" />
      <div className="relative rounded-2xl border border-emerald-300/20 bg-[#071117]/95 p-2 shadow-[0_28px_90px_rgba(0,0,0,0.55),0_0_60px_rgba(16,185,129,0.08)] sm:p-3">
        <div className="flex items-center justify-between border-b border-white/[0.07] px-3 py-2.5 sm:px-4">
          <div className="flex items-center gap-2.5">
            <span className="flex h-6 w-6 items-center justify-center rounded-md bg-emerald-400/10 text-emerald-300"><Shield size={15} /></span>
            <span className="text-xs font-medium text-neutral-200">GlassHouse</span>
            <span className="hidden text-[10px] text-neutral-600 sm:inline">Secure Sandboxed Execution</span>
          </div>
          <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-400/15 bg-emerald-400/[0.06] px-2 py-1 text-[10px] text-emerald-300"><span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />Illustrative preview</span>
        </div>
        <div className="grid min-h-[280px] grid-cols-[108px_minmax(0,1fr)] sm:min-h-[345px] sm:grid-cols-[136px_minmax(0,1fr)]">
          <aside className="border-r border-white/[0.07] p-2 sm:p-3">
            <div className="mb-2 px-1 text-[9px] font-medium tracking-[0.16em] text-neutral-600">EXPLORER</div>
            {['main.py', 'helpers.py', 'README.md'].map((name, i) => (
              <div key={name} className={`mb-1 flex items-center gap-1.5 rounded-md px-1.5 py-2 text-[10px] sm:px-2 sm:text-[11px] ${i === 0 ? 'bg-emerald-400/[0.10] text-emerald-200' : 'text-neutral-500'}`}>
                <FileCode2 size={12} className="shrink-0" /> <span className="truncate">{name}</span>
              </div>
            ))}
          </aside>
          <div className="flex min-w-0 flex-col">
            <div className="flex items-center justify-between gap-2 border-b border-white/[0.07] px-3 py-2.5 sm:px-4">
              <div className="flex items-center gap-2 text-[11px] text-neutral-300"><span>main.py</span><span className="rounded border border-white/10 px-1.5 py-0.5 text-[9px] text-neutral-500">Python</span></div>
              <button type="button" disabled className="inline-flex cursor-default items-center gap-1.5 rounded-md bg-emerald-400 px-2.5 py-1.5 text-[10px] font-semibold text-[#04221a] opacity-90"><CirclePlay size={12} fill="currentColor" /> Run</button>
            </div>
            <div className="flex-1 space-y-2 px-3 py-4 font-mono text-[10px] leading-5 sm:px-5 sm:py-5 sm:text-[11px]">
              {codeLines.map((line, i) => <div key={i} className="flex gap-4"><span className="w-3 shrink-0 select-none text-right text-neutral-700">{i + 1}</span><span className="text-neutral-300">{line}</span></div>)}
            </div>
            <div className="border-t border-white/[0.07] px-3 py-2.5 sm:px-4">
              <div className="mb-2 flex items-center gap-2 text-[9px] font-medium tracking-[0.14em] text-neutral-500"><span className="h-1.5 w-1.5 rounded-full bg-emerald-400" /> SAMPLE OUTPUT</div>
              <div className="rounded-md bg-black/30 px-3 py-2 font-mono text-[10px] text-neutral-400">Code runs in an isolated sandbox.</div>
            </div>
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-white/[0.07] px-3 py-2.5 sm:px-4">
          <span className="text-[10px] text-neutral-500">Sample UI · not a live session</span>
          <div className="flex flex-wrap gap-2">
            {['Sandboxed', 'Network restricted', 'Audit trail'].map((item) => <span key={item} className="inline-flex items-center gap-1 rounded-full border border-white/[0.08] px-2 py-1 text-[9px] text-neutral-500"><Check size={10} className="text-emerald-400" />{item}</span>)}
          </div>
        </div>
      </div>
      <div className="absolute -bottom-5 -left-4 hidden items-center gap-3 rounded-xl border border-emerald-300/20 bg-[#071117] px-4 py-3 shadow-xl sm:flex">
        <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-emerald-400/10 text-emerald-300"><UsersRound size={16} /></span>
        <span><span className="block text-[11px] font-medium text-neutral-200">Shared workspace</span><span className="mt-0.5 block text-[10px] text-neutral-500">Presence-aware editing</span></span>
      </div>
    </div>
  );
}

export function LandingPage() {
  const user = useAuthStore((state) => state.user);
  const startHref = user ? '/editor' : '/login';

  return (
    <main>
      <section id="home" className="relative border-b border-white/[0.07]">
        <div className="pointer-events-none absolute inset-0 overflow-hidden">
          <div className="absolute -top-48 left-[35%] h-[500px] w-[500px] rounded-full bg-emerald-500/[0.06] blur-[100px]" />
          <div className="absolute bottom-0 right-0 h-px w-2/3 bg-gradient-to-l from-emerald-300/20 to-transparent" />
        </div>
        <div className="relative mx-auto grid max-w-[1440px] items-center gap-14 px-5 py-16 sm:px-8 sm:py-20 lg:grid-cols-[0.82fr_1.18fr] lg:gap-12 lg:px-12 lg:py-20">
          <div className="max-w-[560px]">
            <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-emerald-300/20 bg-emerald-300/[0.06] px-3 py-1.5 text-[11px] font-medium tracking-wide text-emerald-300">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" /> Secure <span className="text-emerald-300/40">·</span> Collaborative <span className="text-emerald-300/40">·</span> AI-Powered
            </div>
            <h1 className="text-[clamp(2.5rem,5vw,4.4rem)] font-semibold leading-[1.04] tracking-[-0.045em] text-neutral-100">
              Secure Code Execution <span className="bg-gradient-to-r from-emerald-300 via-teal-300 to-emerald-400 bg-clip-text text-transparent">Without Compromising</span> Collaboration.
            </h1>
            <p className="mt-6 max-w-[500px] text-[15px] leading-7 text-neutral-400 sm:text-base">
              GlassHouse is a secure, collaborative development platform that lets you write, execute and analyze code — safely.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <Link to={startHref} state={!user ? { from: { pathname: '/editor' } } : undefined} className="inline-flex items-center gap-2 rounded-lg bg-gradient-to-r from-emerald-400 to-teal-300 px-6 py-3 text-sm font-semibold text-[#03120f] shadow-[0_10px_34px_rgba(16,185,129,0.18)] transition hover:brightness-110 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-300">
                <CirclePlay size={17} fill="currentColor" /> Start Coding
              </Link>
              <Link to="/login" className="inline-flex items-center gap-2 rounded-lg border border-white/15 bg-white/[0.02] px-6 py-3 text-sm font-medium text-neutral-200 transition hover:border-emerald-300/40 hover:bg-emerald-300/[0.05]">
                Login
              </Link>
            </div>
            <div className="mt-8 flex flex-wrap gap-x-5 gap-y-2 text-[11px] text-neutral-500">
              <span className="inline-flex items-center gap-1.5"><Shield size={13} className="text-emerald-400" /> Isolated execution</span>
              <span className="inline-flex items-center gap-1.5"><Network size={13} className="text-emerald-400" /> Network controls</span>
              <span className="inline-flex items-center gap-1.5"><Zap size={13} className="text-emerald-400" /> Live collaboration</span>
            </div>
          </div>
          <EditorPreview />
        </div>
      </section>

      <section id="features" className="mx-auto max-w-[1440px] scroll-mt-24 px-5 py-16 sm:px-8 lg:px-12 lg:py-20">
        <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
          <div><p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-emerald-300">Built for safe development</p><h2 className="mt-2 text-2xl font-semibold tracking-tight sm:text-3xl">Tools for the way teams build</h2></div>
          <span className="text-sm text-neutral-500">One workspace. Thoughtful security.</span>
        </div>
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {features.map(({ id, icon: Icon, title, description }) => (
            <a key={id} id={id} href={`#${id}`} className="group scroll-mt-28 rounded-xl border border-emerald-300/[0.12] bg-[#061016]/80 p-6 transition duration-200 hover:-translate-y-1 hover:border-emerald-300/30 hover:bg-emerald-300/[0.035]">
              <span className="flex h-11 w-11 items-center justify-center rounded-lg border border-emerald-300/30 bg-emerald-300/[0.06] text-emerald-300"><Icon size={21} strokeWidth={1.7} /></span>
              <h3 className="mt-5 text-base font-semibold text-neutral-100">{title}</h3>
              <p className="mt-2 min-h-[60px] text-[13px] leading-5 text-neutral-500">{description}</p>
              <span className="mt-4 inline-flex h-7 w-7 items-center justify-center rounded-full border border-emerald-400/40 text-emerald-300 transition group-hover:bg-emerald-400 group-hover:text-[#04150f]"><ChevronRight size={15} /></span>
            </a>
          ))}
        </div>
      </section>

      <section id="about" className="scroll-mt-24 border-y border-white/[0.07] bg-[#050d12]">
        <div className="mx-auto grid max-w-[1440px] gap-12 px-5 py-16 sm:px-8 lg:grid-cols-[0.9fr_1.1fr] lg:items-center lg:px-12 lg:py-20">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-emerald-300">Why GlassHouse?</p>
            <h2 className="mt-3 max-w-md text-3xl font-semibold leading-tight tracking-tight">Build boldly. Keep boundaries clear.</h2>
            <p className="mt-4 max-w-lg text-sm leading-6 text-neutral-400">Bring writing, execution, collaboration, and code-risk analysis into one development workspace designed with isolation in mind.</p>
            <div className="mt-7 grid gap-4 sm:grid-cols-2">
              {[
                ['Isolated containers', 'Run programs in managed execution environments.'],
                ['Safe execution', 'Apply configured resource limits to code runs.'],
                ['Network controls', 'Use the sandbox network restrictions configured for execution.'],
                ['Shared editing', 'Work from synchronized files with participant presence.'],
              ].map(([title, body]) => <div key={title} className="flex gap-3"><span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-emerald-300/25 bg-emerald-300/[0.05] text-emerald-300"><Check size={13} /></span><div><h3 className="text-[13px] font-medium text-neutral-200">{title}</h3><p className="mt-1 text-xs leading-5 text-neutral-500">{body}</p></div></div>)}
            </div>
          </div>
          <div className="relative mx-auto flex min-h-[290px] w-full max-w-[540px] items-center justify-center">
            <div className="absolute h-56 w-56 rounded-full bg-emerald-400/[0.08] blur-[75px]" />
            <div className="relative flex h-48 w-48 items-center justify-center rounded-[42px] border border-emerald-300/25 bg-gradient-to-br from-emerald-300/[0.12] to-[#071117] shadow-[0_0_80px_rgba(16,185,129,0.08)]">
              <div className="absolute inset-4 rounded-[34px] border border-emerald-300/15" />
              <div className="flex h-20 w-20 items-center justify-center rounded-2xl border border-emerald-300/30 bg-emerald-300/[0.08] text-emerald-300"><Shield size={42} strokeWidth={1.35} /></div>
              <span className="absolute -top-4 left-1/2 -translate-x-1/2 rounded-full border border-emerald-300/25 bg-[#071117] px-3 py-1.5 text-[10px] text-emerald-200">Isolated containers</span>
              <span className="absolute -bottom-4 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-full border border-emerald-300/25 bg-[#071117] px-3 py-1.5 text-[10px] text-emerald-200">Configured execution controls</span>
              <span className="absolute -left-9 top-1/2 -translate-y-1/2 rounded-full border border-white/10 bg-[#071117] px-3 py-1.5 text-[10px] text-neutral-400">Network restrictions</span>
              <span className="absolute -right-7 top-1/2 -translate-y-1/2 rounded-full border border-white/10 bg-[#071117] px-3 py-1.5 text-[10px] text-neutral-400">Risk analysis</span>
            </div>
          </div>
        </div>
      </section>

      <section className="mx-auto flex max-w-[1440px] flex-col items-start justify-between gap-5 px-5 py-12 sm:flex-row sm:items-center sm:px-8 lg:px-12">
        <div><h2 className="text-xl font-semibold">Ready to get started?</h2><p className="mt-1 text-sm text-neutral-500">Sign in to open your GlassHouse workspace.</p></div>
        <Link to={startHref} state={!user ? { from: { pathname: '/editor' } } : undefined} className="inline-flex items-center gap-2 rounded-lg bg-emerald-400 px-5 py-2.5 text-sm font-semibold text-[#03120f] transition hover:bg-emerald-300">Open GlassHouse <ArrowRight size={16} /></Link>
      </section>
    </main>
  );
}
