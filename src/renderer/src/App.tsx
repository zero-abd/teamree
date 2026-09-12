export function App(): React.JSX.Element {
  const { platform, versions } = window.teamree

  return (
    <main className="shell">
      <h1>teamree</h1>
      <p className="tagline">An ADE built for teamwork.</p>
      <dl className="facts">
        <dt>platform</dt>
        <dd>{platform}</dd>
        <dt>electron</dt>
        <dd>{versions.electron}</dd>
        <dt>chrome</dt>
        <dd>{versions.chrome}</dd>
        <dt>node</dt>
        <dd>{versions.node}</dd>
      </dl>
    </main>
  )
}
