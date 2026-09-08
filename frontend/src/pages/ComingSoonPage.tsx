interface ComingSoonPageProps {
  title: string;
  description: string;
  badge: 'Coming Soon' | 'Preview' | 'Backend Required';
}

const BADGE_STYLES: Record<ComingSoonPageProps['badge'], string> = {
  'Coming Soon': 'bg-white/5 text-neutral-400 border-white/10',
  Preview: 'bg-amber-500/10 text-amber-400 border-amber-500/20',
  'Backend Required': 'bg-red-500/10 text-red-400 border-red-500/20',
};

/**
 * Used for every route whose backend doesn't exist yet (/sessions,
 * /collaboration, /risk, /admin). Deliberately makes no API calls —
 * per project rules, unavailable features must not appear functional.
 */
export function ComingSoonPage({ title, description, badge }: ComingSoonPageProps) {
  return (
    <div className="flex h-full items-center justify-center p-6">
      <div className="max-w-md rounded-lg border border-white/10 bg-neutral-900/60 p-8 text-center">
        <span
          className={`mb-4 inline-block rounded-full border px-3 py-1 text-xs font-medium ${BADGE_STYLES[badge]}`}
        >
          {badge}
        </span>
        <h1 className="mb-2 text-lg font-semibold text-neutral-100">{title}</h1>
        <p className="text-sm text-neutral-400">{description}</p>
      </div>
    </div>
  );
}