interface ComingSoonPageProps {
  title: string;
  description: string;
  badge: 'Backend Required';
}

const BADGE_STYLES: Record<ComingSoonPageProps['badge'], string> = {
  'Backend Required': 'bg-red-500/10 text-red-400 border-red-500/20',
};

/**
 * Used for every route whose backend doesn't exist yet (/collaboration,
 * /admin). Deliberately makes no API calls — per project rules,
 * unavailable features must not appear functional.
 * (/risk has a local-heuristic preview — pages/RiskAnalysisPage.tsx.
 *  /sessions has local-only snapshots — pages/SessionsPage.tsx.)
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