export default function Placeholder({ title, desc }: { title: string; desc: string }) {
  return (
    <div>
      <div className="page-head"><h1>{title}</h1></div>
      <div className="card" style={{ maxWidth: 520, marginTop: 12 }}>
        <div className="muted">{desc}</div>
      </div>
    </div>
  );
}
