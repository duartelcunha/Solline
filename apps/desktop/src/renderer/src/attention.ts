import '@solline/ui/fonts.css';
import './attention.css';
type Notice = { title: string; body: string; theme: 'light' | 'dark' };
declare global {
  interface Window {
    sollineAttention: {
      notice(): Promise<Notice>;
      action(action: 'open' | 'dismiss'): Promise<void>;
      onNotice(listener: (notice: Notice) => void): () => void;
    };
  }
}
const title = document.getElementById('title');
const body = document.getElementById('body');
function show(notice: Notice) {
  document.documentElement.dataset.theme = notice.theme;
  if (title) title.textContent = notice.title;
  if (body) body.textContent = notice.body;
  document
    .getElementById('open')
    ?.setAttribute('aria-label', `${notice.title}. ${notice.body}. Abrir conversa`);
}
const off = window.sollineAttention.onNotice(show);
void window.sollineAttention.notice().then(show);
for (const action of ['open', 'dismiss'] as const)
  document.getElementById(action)?.addEventListener('click', () => {
    void window.sollineAttention.action(action);
  });
window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') void window.sollineAttention.action('dismiss');
});
window.addEventListener('unload', off, { once: true });
