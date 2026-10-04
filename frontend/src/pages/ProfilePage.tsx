export function ProfilePage() {
  return (
    <section className="mx-auto flex w-full max-w-3xl flex-col gap-6 p-6">
      <header>
        <h1 className="text-xl font-semibold text-neutral-100">User Profile</h1>
        <p className="mt-1 text-sm text-neutral-400">
          Account details and profile management.
        </p>
      </header>

      <section className="rounded-lg border border-white/10 bg-neutral-900/60 p-5">
        <h2 className="text-sm font-semibold text-neutral-200">Profile unavailable</h2>
        <p className="mt-2 text-sm leading-6 text-neutral-400">
          GlassHouse does not currently have authentication or a user profile service connected.
          No signed-in account is available to display or edit. Sign-in, profile updates, and
          sign-out will be available when an authenticated account service is configured.
        </p>
      </section>
    </section>
  );
}
