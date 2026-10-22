import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Bot, HOODS, MOODS, type Hood, type Mood } from '@solline/ui/bot';
import '../src/renderer/src/styles.css';

function FamilyGallery() {
  return (
    <main className="min-h-full bg-bg p-10 text-fg">
      <h1 className="text-2xl font-semibold">Solline · família e expressões</h1>
      <p className="mt-2 text-muted">Cada identidade, a 48 px, em todos os estados.</p>
      <div className="mt-8 grid gap-4">
        {(Object.keys(HOODS) as Hood[]).map((hood) => (
          <section
            key={hood}
            aria-label={hood}
            className="flex items-center gap-6 rounded-lg border border-line bg-surface p-4"
          >
            <h2 className="w-20 text-sm font-medium">{hood}</h2>
            {MOODS.map((mood) => (
              <div key={mood} className="flex w-24 flex-col items-center gap-2">
                <Bot hood={hood} mood={mood} size={48} title={`${hood}: ${mood}`} />
                <span className="text-xs text-muted">{mood}</span>
              </div>
            ))}
          </section>
        ))}
      </div>
    </main>
  );
}

function Gallery() {
  const [mood, setMood] = useState<Mood>('waiting');
  return (
    <main className="min-h-full bg-bg p-10 text-fg">
      <h1 className="text-2xl font-semibold">Solline · expressões</h1>
      <p className="mt-2 text-muted">A mesma personagem, em cada momento do trabalho.</p>
      <div className="mt-8 flex flex-wrap gap-6">
        {MOODS.map((m) => (
          <section key={m} className="rounded-lg border border-line bg-surface p-4 text-center">
            <Bot hood="familiar" mood={m} size={96} title={m} />
            <div className="my-3 flex items-center justify-center gap-3">
              <Bot hood="claude" mood={m} size={24} />
              <Bot hood="codex" mood={m} size={40} />
            </div>
            <p className="text-xs text-muted">{m}</p>
          </section>
        ))}
      </div>
      <section
        className="mt-10 rounded-lg border border-line bg-surface p-6"
        aria-label="Movimento"
      >
        <div data-testid="live-figure">
          <Bot hood="solline" mood={mood} size={120} alive title={`Solline: ${mood}`} />
        </div>
        <div className="flex flex-wrap gap-2">
          {MOODS.map((m) => (
            <button
              type="button"
              key={m}
              onClick={() => setMood(m)}
              className="rounded-control border border-line px-3 py-2"
              aria-pressed={mood === m}
            >
              {m}
            </button>
          ))}
        </div>
      </section>
      <div className="h-[1200px]" aria-hidden />
      <button type="button">Fim da galeria</button>
    </main>
  );
}
document.documentElement.dataset.theme =
  new URLSearchParams(location.search).get('theme') === 'dark' ? 'dark' : 'light';
const root = document.getElementById('root');
if (!root) throw new Error('Missing gallery root');
createRoot(root).render(
  new URLSearchParams(location.search).has('family') ? <FamilyGallery /> : <Gallery />,
);
