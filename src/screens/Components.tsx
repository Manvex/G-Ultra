import { useMemo, useState } from 'react';
import { Activity, BatteryFull, Camera, Check, CircuitBoard, Copy, Cpu, Fan, Gpu, HardDrive, Keyboard, Laptop, Layers, Loader2, MemoryStick, Monitor, Search, Smartphone, Usb, Volume2, Wifi, type LucideIcon } from 'lucide-react';
import { bridge } from '../lib/bridge';
import { useData } from '../lib/store';
import type { ComponentItem, ComponentsData } from '../lib/types';
import { Glass, PageHead, toast } from '../ui/kit';

const ICONS: Record<string, LucideIcon> = {
  board: CircuitBoard,
  cpu: Cpu,
  gpu: Gpu,
  ram: MemoryStick,
  storage: HardDrive,
  display: Monitor,
  battery: BatteryFull,
  cooling: Fan,
  network: Wifi,
  audio: Volume2,
  camera: Camera,
  input: Keyboard,
  ports: Usb,
  slots: Layers,
  sensors: Activity,
};

const REPLACE: Record<string, { label: string; color: string; bg: string }> = {
  yes: { label: 'Replaceable', color: '#7ee8a0', bg: 'rgba(48,209,88,.16)' },
  tech: { label: 'Repair shop', color: '#9fdcff', bg: 'rgba(100,210,255,.15)' },
  check: { label: 'Depends on model', color: '#ffc56b', bg: 'rgba(255,159,10,.16)' },
  no: { label: 'Soldered', color: 'var(--ink-2)', bg: 'rgba(255,255,255,.08)' },
};

// navigator.clipboard isn't available in every context, so there's an older fallback.
async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const area = document.createElement('textarea');
    area.value = text;
    document.body.appendChild(area);
    area.select();
    document.execCommand('copy');
    area.remove();
  }
}

function itemText(item: ComponentItem) {
  return [item.name, ...item.specs.map(([k, v]) => `  ${k}: ${v}`)].join('\n');
}

function Part({ item }: { item: ComponentItem }) {
  const [copied, setCopied] = useState(false);
  const replace = item.replace ? REPLACE[item.replace] : null;
  return (
    <div className="part">
      <div className="row between wrap" style={{ gap: 8 }}>
        <div className="row wrap" style={{ gap: 8, minWidth: 0, flex: 1 }}>
          <div className="part-name">{item.name}</div>
          {replace && (
            <span className="badge" style={{ color: replace.color, background: replace.bg }}>
              {replace.label}
            </span>
          )}
        </div>
        <div className="row" style={{ gap: 6, flex: 'none' }}>
          {item.specs.length > 0 && (
            <button
              className="btn icon sm"
              style={{ width: 30, height: 30 }}
              aria-label={`Copy details of ${item.name}`}
              title="Copy details"
              onClick={() => {
                void copyText(itemText(item));
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              }}
            >
              {copied ? <Check size={14} color="var(--good)" /> : <Copy size={14} />}
            </button>
          )}
          {item.search && (
            <button className="btn sm" onClick={() => bridge.openLink(`https://www.google.com/search?q=${encodeURIComponent(item.search!)}`)} title={`Search the web for: ${item.search}`}>
              <Search size={13} /> Find it
            </button>
          )}
        </div>
      </div>
      {item.note && <p className="section-sub" style={{ margin: '4px 0 0' }}>{item.note}</p>}
      {item.specs.length > 0 && (
        <dl className="part-specs">
          {item.specs.map(([k, v]) => (
            <div key={k}>
              <dt>{k}</dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}

export function Components() {
  const data = useData<ComponentsData>('components', () => bridge.components(), 3600000);
  const [query, setQuery] = useState('');
  const isAndroid = bridge.platform === 'android';

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const all = data.data?.groups ?? [];
    if (!q) return all;
    return all
      .map((g) => ({
        ...g,
        items: g.title.toLowerCase().includes(q) ? g.items : g.items.filter((i) => i.name.toLowerCase().includes(q) || i.specs.some(([k, v]) => k.toLowerCase().includes(q) || v.toLowerCase().includes(q))),
      }))
      .filter((g) => g.items.length > 0);
  }, [data.data, query]);

  const copyAll = () => {
    const all = data.data?.groups ?? [];
    const text = all.map((g) => `== ${g.title} ==\n${g.items.map(itemText).join('\n')}`).join('\n\n');
    void copyText(text);
    toast('The full list is on your clipboard.');
  };

  return (
    <div className="stack">
      <PageHead
        title="Components"
        subtitle={isAndroid ? "Everything in your phone, with what you'd need to find a replacement." : "Everything in your PC, with what you'd need to find a replacement."}
        actions={
          data.data && (
            <button className="btn" onClick={copyAll}>
              <Copy size={15} /> Copy all
            </button>
          )
        }
      />

      <Glass className="search">
        <Search size={16} className="dim" style={{ flex: 'none' }} />
        <input type="text" value={query} placeholder="Search parts, part numbers, makers…" aria-label="Search components" onChange={(e) => setQuery(e.target.value)} />
      </Glass>

      {data.loading && !data.data && (
        <Glass className="card row">
          <Loader2 size={17} className="spin" /> Reading your hardware…
        </Glass>
      )}
      {!data.data && !data.loading && (
        <Glass className="card">
          <p className="dim" style={{ margin: 0 }}>
            The hardware list couldn't be read{data.error ? `: ${data.error}` : '.'}
          </p>
        </Glass>
      )}

      {groups.map((g) => {
        const Icon = g.id === 'system' ? (isAndroid ? Smartphone : Laptop) : ICONS[g.id] ?? Layers;
        return (
          <Glass className="card" key={g.id}>
            <div className="row" style={{ gap: 10 }}>
              <Icon size={17} className="dim" />
              <h2 className="section-title">{g.title}</h2>
              {g.items.length > 1 && <span className="badge">{g.items.length}</span>}
            </div>
            <div style={{ marginTop: 4 }}>
              {g.items.map((item, i) => (
                <Part key={`${item.name}-${i}`} item={item} />
              ))}
            </div>
          </Glass>
        );
      })}
      {data.data && groups.length === 0 && <div className="empty-state">Nothing matches "{query}".</div>}
    </div>
  );
}
