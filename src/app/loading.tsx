export default function Loading() {
  return (
    <main className="page route-loading" aria-live="polite" aria-busy="true">
      <div className="route-loading-heading" />
      <div className="route-loading-subheading" />
      <section className="route-loading-grid" aria-label="Loading workspace">
        {Array.from({ length: 7 }, (_, index) => (
          <div className="route-loading-card" key={index} />
        ))}
      </section>
    </main>
  );
}
