import {
  GROUP_NAME,
  type AgendaEvent,
  type AgendaState,
  type ClientMessage,
  type ListKind,
  type ServerMessage,
  type Speaker,
} from "../shared/types.js";

// ---------- constantes ----------

const EVENT_DAYS = ["2026-11-11", "2026-11-12", "2026-11-13", "2026-11-14"];
const WEEKDAYS = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"];
const MONTHS = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];
const AVATAR_SRC = "/avatar.png";

/** Perfil único do grupo: todos marcam como "Amigos da Computaria", sem cadastro. */
const ME = GROUP_NAME;

// ---------- estado ----------

let state: AgendaState = { events: [], votes: {}, reserved: {} };
let loaded = false;
let previouslyLoaded = false;
let mounted = false;
let selectedDay = EVENT_DAYS[0]!;
let view: "programacao" | "minha" = "minha";
let listMode: ListKind = "favorites";
let search = "";
let searchOpen = false;
let modal: { kind: "event"; id: string } | { kind: "form" } | null = null;
let socket: WebSocket | null = null;
let online = false;

/** Coração que deve tocar a animação na próxima renderização (feedback imediato). */
let popId: string | null = null;
/** Controle para animar a entrada dos cards só quando eles aparecem pela primeira vez. */
let listKey = "";
let seenIds = new Set<string>();
let closeTimer: number | undefined;

// ---------- utilidades ----------

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function dayLabel(date: string): { wd: string; num: number; month: string } {
  const d = new Date(`${date}T12:00:00`);
  return { wd: WEEKDAYS[d.getDay()]!, num: d.getDate(), month: MONTHS[d.getMonth()]! };
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join("");
}

function timeLabel(ev: AgendaEvent): string {
  return ev.start ? `${ev.start}-${ev.end}` : "Horário a definir";
}

function toast(message: string): void {
  const el = $("toast");
  el.textContent = message;
  el.classList.add("show");
  window.clearTimeout(toast.timer);
  toast.timer = window.setTimeout(() => el.classList.remove("show"), 2600);
}
toast.timer = 0 as number;

// ---------- votação ----------

const VOTER_KEY = "agenda.voter";
let voterCache = "";

/** Identificador do navegador: cada navegador vota uma vez por dia. */
function voterId(): string {
  if (voterCache) return voterCache;
  try {
    const saved = localStorage.getItem(VOTER_KEY);
    if (saved) {
      voterCache = saved;
      return saved;
    }
  } catch {
    /* sem armazenamento: vale só nesta sessão */
  }
  voterCache = crypto.randomUUID();
  try {
    localStorage.setItem(VOTER_KEY, voterCache);
  } catch {
    /* ignora */
  }
  return voterCache;
}

function voteCount(eventId: string): number {
  return (state.votes[eventId] ?? []).length;
}

function iVoted(eventId: string): boolean {
  return (state.votes[eventId] ?? []).includes(voterId());
}

/** Já votei em algum evento deste dia? */
function votedOnDay(day: string): boolean {
  return state.events.some((e) => e.date === day && iVoted(e.id));
}

function dayHasWinner(day: string): boolean {
  return state.events.some((e) => e.date === day && state.reserved[e.id] === "votacao");
}

function isReserved(eventId: string): boolean {
  return !!state.reserved[eventId];
}

/** Copia texto; usa o método antigo como plano B (ex.: http sem contexto seguro). */
async function copyText(text: string, okMessage: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast(okMessage);
  } catch {
    const area = document.createElement("textarea");
    area.value = text;
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.append(area);
    area.select();
    const ok = document.execCommand("copy");
    area.remove();
    toast(ok ? okMessage : `Não consegui copiar. Copie manualmente: ${text}`);
  }
}

// ---------- ícones (SVG inline) ----------

const ICON = {
  heart: (on: boolean) =>
    `<svg viewBox="0 0 24 24" width="22" height="22" fill="${on ? "currentColor" : "none"}" stroke="currentColor" stroke-width="2" stroke-linejoin="round" aria-hidden="true"><path d="M12 21s-7.5-4.6-9.5-9.1C1.1 8.6 3.2 5 6.8 5c2 0 3.5 1.1 4.2 2.4C11.7 6.1 13.2 5 15.2 5c3.6 0 5.7 3.6 4.3 6.9C19.5 16.4 12 21 12 21z"/></svg>`,
  bookmark: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M6 3h12v18l-6-4-6 4z"/></svg>`,
  search: `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/></svg>`,
  link: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7.1 0l3-3a5 5 0 0 0-7.1-7.1l-1 1"/><path d="M14 11a5 5 0 0 0-7.1 0l-3 3a5 5 0 0 0 7.1 7.1l1-1"/></svg>`,
  pin: `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M12 21s-6-5.4-6-10a6 6 0 1 1 12 0c0 4.6-6 10-6 10z"/><circle cx="12" cy="11" r="2"/></svg>`,
  people: `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="9" cy="8" r="3"/><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6"/><path d="M16 5a3 3 0 0 1 0 6M21 20c0-2.6-1.6-4.8-4-5.6"/></svg>`,
  calendar: `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/></svg>`,
  plus: `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.4" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>`,
  close: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>`,
};

// ---------- estrutura da página (montada uma vez) ----------

function mountShell(): void {
  $("app").innerHTML = `
    <div class="bg-glow" aria-hidden="true"></div>
    <header class="topbar" id="topbar">
      <button class="round-btn" data-action="toggle-search" aria-label="Buscar">${ICON.search}</button>
      <nav class="pill-nav" aria-label="Navegação" id="nav">
        <span class="pill-thumb" id="pill-thumb"></span>
        <button data-action="view" data-view="programacao">${ICON.calendar}<span>Programação</span></button>
        <button data-action="view" data-view="minha">${ICON.heart(true)}<span>Minha Agenda</span></button>
      </nav>
      <div class="user-area">
        <span class="live" id="live" title="Reconectando..."></span>
        <button class="round-btn" data-action="copy-agenda" aria-label="Copiar link da agenda" title="Copiar link da agenda">${ICON.link}</button>
        <div class="user-chip">
          <img class="avatar-img" src="${AVATAR_SRC}" alt="" />
          <span>${esc(ME)}</span>
        </div>
      </div>
    </header>

    <div id="search-slot"></div>

    <section class="days" aria-label="Dias">
      <span class="day-ind" id="day-ind"></span>
      <div class="days-grid" id="days-grid"></div>
    </section>

    <div id="mode-slot"></div>

    <main class="list" id="list"></main>

    <button class="fab" data-action="new-event" aria-label="Adicionar evento pelo link">${ICON.plus}<span>Adicionar pelo link</span></button>
  `;

  window.addEventListener(
    "scroll",
    () => $("topbar").classList.toggle("scrolled", window.scrollY > 8),
    { passive: true },
  );
  window.addEventListener("resize", () => {
    updateNav();
    updateDays();
  });
}

// ---------- atualizações parciais (sem recriar o que já existe) ----------

function render(): void {
  if (!mounted) {
    mountShell();
    mounted = true;
  }
  updateStatus();
  updateSearch();
  updateDays();
  updateMode();
  updateNav();
  updateList();
  renderModal();
}

function updateStatus(): void {
  const live = $("live");
  live.classList.toggle("on", online);
  live.title = online ? "Ao vivo" : "Reconectando...";
}

function updateNav(): void {
  const buttons = $("nav").querySelectorAll<HTMLButtonElement>("button[data-view]");
  let active: HTMLButtonElement | null = null;
  buttons.forEach((btn) => {
    const on = btn.dataset.view === view;
    btn.classList.toggle("active", on);
    if (on) active = btn;
  });
  if (active) {
    const b = active as HTMLButtonElement;
    const thumb = $("pill-thumb");
    thumb.style.width = `${b.offsetWidth}px`;
    thumb.style.transform = `translateX(${b.offsetLeft}px)`;
  }
}

function updateSearch(): void {
  const slot = $("search-slot");
  if (!searchOpen) {
    slot.innerHTML = "";
    return;
  }
  if (slot.querySelector("#search")) return;
  slot.innerHTML = `<div class="search-row"><input id="search" type="search" placeholder="Buscar evento, palestrante ou tag" value="${esc(search)}" autocomplete="off" /></div>`;
  const input = $("search") as HTMLInputElement;
  input.addEventListener("input", () => {
    search = input.value;
    updateList();
  });
  input.focus();
}

function updateDays(): void {
  const idx = EVENT_DAYS.indexOf(selectedDay);
  $("days-grid").innerHTML = EVENT_DAYS.map((d, i) => {
    const l = dayLabel(d);
    return `<button class="day ${i === idx ? "active" : ""}" data-action="day" data-day="${d}">
      <span class="wd">${l.wd}</span>
      <span class="dn">${l.num} ${l.month}</span>
    </button>`;
  }).join("");
  $("day-ind").style.transform = `translateX(${Math.max(idx, 0) * 100}%)`;
}

function updateMode(): void {
  const slot = $("mode-slot");
  if (view !== "minha") {
    slot.innerHTML = "";
    return;
  }
  if (!slot.querySelector(".segmented")) {
    slot.innerHTML = `
      <div class="segmented" role="tablist">
        <span class="seg-thumb" id="seg-thumb"></span>
        <button data-action="mode" data-mode="reserved">${ICON.bookmark} Reservados</button>
        <button data-action="mode" data-mode="favorites">${ICON.heart(true)} Favoritos</button>
      </div>`;
  }
  const modes = slot.querySelectorAll<HTMLButtonElement>("button[data-mode]");
  modes.forEach((btn) => btn.classList.toggle("active", btn.dataset.mode === listMode));
  const idx = listMode === "favorites" ? 1 : 0;
  $("seg-thumb").style.left = `calc(6px + ${idx} * ((100% - 22px) / 2 + 10px))`;
}

// ---------- lista e cards ----------

function filterBySearch(events: AgendaEvent[], q: string): AgendaEvent[] {
  return events.filter((ev) =>
    [ev.title, ev.location, ev.organizer, ev.tags.join(" "), ev.speakers.map((s) => s.name).join(" ")]
      .join(" ")
      .toLowerCase()
      .includes(q),
  );
}

function visibleEvents(): AgendaEvent[] {
  const q = search.trim().toLowerCase();
  let events = state.events.filter((ev) => ev.date === selectedDay);

  if (view === "minha") {
    if (listMode === "reserved") {
      events = events.filter((ev) => isReserved(ev.id));
    } else {
      // Favoritos = eventos em votação (com voto e ainda não reservados), do mais votado ao menos
      events = events.filter((ev) => !isReserved(ev.id) && voteCount(ev.id) > 0);
      events.sort((a, b) => voteCount(b.id) - voteCount(a.id));
      if (q) return filterBySearch(events, q);
      return events;
    }
  }

  if (q) {
    events = events.filter((ev) =>
      [ev.title, ev.location, ev.organizer, ev.tags.join(" "), ev.speakers.map((s) => s.name).join(" ")]
        .join(" ")
        .toLowerCase()
        .includes(q),
    );
  }

  return events.sort((a, b) => a.start.localeCompare(b.start) || a.title.localeCompare(b.title));
}

function updateList(): void {
  const list = $("list");

  if (!loaded) {
    list.innerHTML = [0, 1, 2].map((i) => `<div class="card skeleton" style="--d:${i * 90}ms"><span></span><span></span><span></span></div>`).join("");
    return;
  }

  const key = `${selectedDay}|${view}|${listMode}|${search}`;
  if (key !== listKey) {
    listKey = key;
    seenIds = new Set();
  }

  const events = visibleEvents();
  const banner = view === "minha" && listMode === "favorites" ? votingBanner() : "";

  let body: string;
  if (events.length === 0) {
    const msg =
      view === "minha"
        ? listMode === "favorites"
          ? "Nenhum evento em votação neste dia. Toque no ❤ de um evento para votar."
          : "Nenhum evento reservado neste dia."
        : "Nenhum evento neste dia.";
    body = `<p class="empty">${esc(msg)}</p>`;
  } else {
    let entering = 0;
    body = events
      .map((ev) => {
        const isNew = !seenIds.has(ev.id);
        seenIds.add(ev.id);
        const delay = isNew ? entering++ * 70 : 0;
        return renderCard(ev, isNew, delay);
      })
      .join("");
  }

  list.innerHTML = banner + body;
  popId = null;
}

/** Faixa de status da votação do dia selecionado. */
function votingBanner(): string {
  const closed = dayHasWinner(selectedDay);
  const voted = votedOnDay(selectedDay);
  const hasVotes = state.events.some((e) => e.date === selectedDay && voteCount(e.id) > 0 && !isReserved(e.id));
  const l = dayLabel(selectedDay);

  const status = closed
    ? "Votação encerrada: o vencedor já está em Reservados."
    : voted
      ? "Seu voto deste dia já foi registrado. Aguarde o encerramento."
      : "Você ainda pode votar uma vez neste dia.";

  return `
    <div class="vote-banner">
      <div>
        <b>Votação de ${l.num} ${cap(l.month)}</b>
        <small>${esc(status)}</small>
      </div>
      ${!closed && hasVotes
        ? `<button class="secondary" data-action="close-voting" data-date="${selectedDay}">Encerrar votação</button>`
        : ""}
    </div>`;
}

function renderCard(ev: AgendaEvent, enter: boolean, delay: number): string {
  const l = dayLabel(ev.date);
  const mine = iVoted(ev.id);
  const pop = ev.id === popId;
  const votes = voteCount(ev.id);
  const winner = state.reserved[ev.id] === "votacao";
  const reserved = isReserved(ev.id);
  const blocked = !!reserved || votedOnDay(ev.date) && !mine || dayHasWinner(ev.date);
  const names = ev.speakers.map((s) => s.name);
  const speakersText = names.length ? names.join(", ") : "A definir";

  const classes = ["card", enter ? "enter" : "", winner ? "winner" : ""].filter(Boolean).join(" ");
  const label = mine ? "Seu voto" : reserved ? "Reservado" : blocked ? "Voto indisponível" : "Votar";
  return `
  <article class="${classes}" style="--d:${delay}ms" data-action="open" data-id="${esc(ev.id)}" tabindex="0">
    <div class="card-top">
      <span class="date-pill"><b>${l.num} ${cap(l.month)}</b> ${esc(timeLabel(ev))}</span>
      <button class="vote ${mine ? "on" : ""} ${pop ? "pop" : ""}" data-action="vote" data-id="${esc(ev.id)}"
        ${blocked && !mine ? "disabled" : ""} aria-label="${esc(label)}" title="${esc(label)}">
        ${ICON.heart(mine)}<span class="vote-count">${votes}</span>
      </button>
    </div>
    <h3>${esc(ev.title)}</h3>
    <p class="meta speakers">${ICON.people} <span>${esc(speakersText)}</span></p>
    ${ev.location ? `<p class="meta">${ICON.pin} <span>${esc(ev.location)}</span></p>` : ""}
    ${ev.tags.length ? `<div class="tags">${ev.tags.map((t) => `<span class="tag">${esc(t)}</span>`).join("")}</div>` : ""}
    ${winner ? `<span class="badge">🏆 Vencedor da votação</span>` : reserved ? `<span class="badge">Reservado pelo grupo</span>` : ""}
    ${votes > 0 && !reserved ? `<div class="vote-bar" title="${votes} voto(s)"><span style="width:${Math.min(100, votes * 25)}%"></span></div>` : ""}
  </article>`;
}

// ---------- modais ----------

/** Mostra o modal com animação; se já estiver aberto, troca só o conteúdo. */
function showModal(html: string, key: string): void {
  const root = $("modal");
  if (closeTimer) {
    window.clearTimeout(closeTimer);
    closeTimer = undefined;
  }

  if (root.hidden || !root.querySelector(".modal")) {
    root.innerHTML = `<div class="modal" role="dialog" aria-modal="true"><div class="modal-content">${html}</div></div>`;
    root.dataset.key = key;
    root.hidden = false;
    document.body.classList.add("no-scroll");
    requestAnimationFrame(() => requestAnimationFrame(() => root.classList.add("open")));
    return;
  }

  root.classList.add("open");
  const content = root.querySelector<HTMLElement>(".modal-content")!;
  // não repinta enquanto a pessoa digita num campo do mesmo modal
  const active = document.activeElement;
  const typing =
    root.dataset.key === key &&
    !!active &&
    content.contains(active) &&
    (active instanceof HTMLInputElement || active instanceof HTMLSelectElement);
  if (typing) return;

  root.dataset.key = key;
  content.innerHTML = html;
}

function closeModal(): void {
  modal = null;
  const root = $("modal");
  root.classList.remove("open");
  document.body.classList.remove("no-scroll");
  if (closeTimer) window.clearTimeout(closeTimer);
  closeTimer = window.setTimeout(() => {
    if (!modal) {
      root.hidden = true;
      root.innerHTML = "";
    }
    closeTimer = undefined;
  }, 280);
}

function renderModal(): void {
  if (!modal) return;
  if (modal.kind === "form") return;
  const openId = modal.id;
  const ev = state.events.find((e) => e.id === openId);
  if (!ev) return closeModal();
  showModal(eventDetail(ev), `event:${ev.id}`);
}

function eventDetail(ev: AgendaEvent): string {
  const l = dayLabel(ev.date);
  const mine = iVoted(ev.id);
  const reserved = isReserved(ev.id);
  const winner = state.reserved[ev.id] === "votacao";
  const dayClosed = dayHasWinner(ev.date);
  const canVote = !reserved && !dayClosed && (mine || !votedOnDay(ev.date));
  const voteLabel = mine
    ? "Seu voto"
    : reserved
      ? "Reservado"
      : dayClosed
        ? "Votação encerrada"
        : votedOnDay(ev.date)
          ? "Você já votou neste dia"
          : "Votar neste evento";
  const mapQuery = encodeURIComponent(ev.address || ev.location || ev.title);

  const row = (icon: string, label: string, value: string) =>
    value ? `<div class="info-row">${icon}<div><small>${label}</small><span>${esc(value)}</span></div></div>` : "";

  return `
    <div class="modal-head">
      <span></span>
      <button class="round-btn" data-action="close" aria-label="Fechar">${ICON.close}</button>
    </div>
    <div class="detail">
      ${ev.image ? `<img class="event-img" src="${esc(ev.image)}" alt="" loading="lazy" />` : ""}
      <h2>${esc(ev.title)}</h2>
      ${ev.tags.length ? `<div class="tags">${ev.tags.map((t) => `<span class="tag">${esc(t)}</span>`).join("")}</div>` : ""}
      ${ev.description ? `<p class="desc">${esc(ev.description)}</p>` : ""}

      <div class="info-list">
        ${row(ICON.calendar, "Formato", ev.format)}
        ${row(ICON.people, "Voltado para", ev.audience)}
        ${row(ICON.pin, "Acesso", ev.access)}
        ${row(ICON.people, "Atividade oferecida por", ev.organizer)}
      </div>

      <p class="when"><b>${l.num} ${cap(l.month)}</b> ${esc(timeLabel(ev))}</p>
      ${ev.location ? `<span class="room-pill">${esc(ev.location)}</span>` : ""}
      ${ev.address ? `<p class="address">${ICON.pin} <a href="https://www.google.com/maps/search/?api=1&query=${mapQuery}" target="_blank" rel="noopener">${esc(ev.address)}</a></p>` : ""}
      ${ev.address
        ? `<iframe class="map" loading="lazy" referrerpolicy="no-referrer-when-downgrade"
             src="https://www.google.com/maps?q=${mapQuery}&output=embed" title="Mapa"></iframe>`
        : ""}

      <div class="vote-panel">
        <p class="vote-meta"><b>${voteCount(ev.id)}</b> voto(s)${winner ? " · 🏆 vencedor da votação" : ""}</p>
        <div class="actions">
          <button class="${mine ? "primary on" : "primary"}" data-action="vote" data-id="${esc(ev.id)}" ${canVote ? "" : "disabled"}>
            ${ICON.heart(mine)} ${esc(voteLabel)}
          </button>
          <button class="${reserved ? "secondary on" : "secondary"}" data-action="reserve" data-id="${esc(ev.id)}" ${winner ? "disabled" : ""}>
            ${ICON.bookmark} ${reserved ? "Reservado" : "Reservar"}
          </button>
        </div>
        <p class="muted small">Cada navegador vota uma vez por dia. O voto não pode ser desfeito.</p>
      </div>

      ${ev.link ? `
      <div class="link-row">
        <button class="secondary" data-action="copy-link" data-link="${esc(ev.link)}">${ICON.link} Copiar link do evento</button>
        <a class="secondary" href="${esc(ev.link)}" target="_blank" rel="noopener">Página oficial</a>
      </div>` : ""}

      <section class="guests">
        <h4>Dia e horário</h4>
        <form data-form="time" data-id="${esc(ev.id)}" class="time-form">
          <select name="date" aria-label="Dia">
            ${EVENT_DAYS.map((d) => {
              const dl = dayLabel(d);
              return `<option value="${d}" ${d === ev.date ? "selected" : ""}>${dl.wd} ${dl.num} ${dl.month}</option>`;
            }).join("")}
          </select>
          <input name="start" type="time" value="${esc(ev.start)}" aria-label="Início" />
          <input name="end" type="time" value="${esc(ev.end)}" aria-label="Fim" />
          <button type="submit" class="secondary">Salvar</button>
        </form>
      </section>

      ${ev.speakers.length ? `
      <section class="guests">
        <h4>Convidados</h4>
        ${ev.speakers.map(renderSpeaker).join("")}
      </section>` : ""}

      <button class="danger" data-action="remove" data-id="${esc(ev.id)}">Excluir evento</button>
    </div>`;
}

function renderSpeaker(s: Speaker): string {
  return `<div class="speaker">
    <span class="avatar">${esc(initials(s.name))}</span>
    <div><b>${esc(s.name)}</b>${s.role ? `<small>${esc(s.role)}</small>` : ""}</div>
  </div>`;
}

/** Formulário mínimo: só o link. O resto vem da página oficial. */
function linkForm(): string {
  return `
    <div class="modal-head">
      <h2>Adicionar evento</h2>
      <button class="round-btn" data-action="close" aria-label="Fechar">${ICON.close}</button>
    </div>
    <p class="muted lead">Cole o link oficial do evento. Título e imagem são preenchidos sozinhos.</p>
    <form data-form="link" class="form">
      <label>Link oficial
        <input name="link" type="url" required placeholder="https://share.jalanlive.com/recnplay2026?activityID=..." />
      </label>
      <p class="status" aria-live="polite"></p>
      <button type="submit" class="primary">Adicionar à agenda</button>
    </form>`;
}

// ---------- ações ----------

function send(msg: ClientMessage): void {
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(msg));
  } else {
    toast("Sem conexão com o servidor. Tentando reconectar...");
  }
}

/** Registra o voto: a pessoa só vota uma vez por dia neste navegador. */
function vote(eventId: string): void {
  const ev = state.events.find((e) => e.id === eventId);
  if (!ev) return;
  if (iVoted(eventId)) return toast("Você já votou neste evento.");
  if (votedOnDay(ev.date)) return toast("Você já votou neste dia. Cada navegador tem um voto por dia.");
  if (dayHasWinner(ev.date)) return toast("A votação deste dia já foi encerrada.");
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    return toast("Sem conexão com o servidor. Tentando reconectar...");
  }

  // feedback imediato; o servidor confirma ou corrige logo em seguida
  state.votes[eventId] = [...(state.votes[eventId] ?? []), voterId()];
  popId = eventId;
  render();
  send({ type: "vote", eventId, voterId: voterId() });
}

function reserve(eventId: string): void {
  send({ type: "reserve", eventId });
}

function closeVoting(day: string): void {
  if (confirm(`Encerrar a votação de ${dayLabel(day).num} ${dayLabel(day).month}? O mais votado vai para Reservados.`)) {
    send({ type: "closeVoting", date: day });
  }
}

/** Busca título e imagem no link oficial e cria o evento automaticamente. */
async function addByLink(form: HTMLFormElement): Promise<void> {
  const raw = String(new FormData(form).get("link") ?? "").trim();
  const btn = form.querySelector<HTMLButtonElement>("button[type=submit]")!;
  const status = form.querySelector<HTMLElement>(".status")!;
  if (!raw) {
    status.textContent = "Cole o link oficial do evento.";
    return;
  }

  btn.disabled = true;
  btn.textContent = "Buscando dados...";
  status.textContent = "";
  try {
    const res = await fetch(`/api/import?url=${encodeURIComponent(raw)}`);
    const data = (await res.json()) as { error?: string; title?: string; link?: string; image?: string };
    if (!res.ok || !data.title) throw new Error(data.error ?? "Não consegui importar esse link.");

    send({
      type: "addEvent",
      event: {
        date: selectedDay,
        start: "",
        end: "",
        title: data.title,
        description: "",
        format: "",
        audience: "",
        access: "",
        organizer: "",
        speakers: [],
        location: "",
        address: "",
        tags: [],
        link: data.link ?? raw,
        image: data.image ?? "",
      },
    });
    closeModal();
    toast("Evento adicionado. Ajuste o dia e horário quando quiser.");
  } catch (err) {
    status.textContent = err instanceof Error ? err.message : "Erro ao importar o link.";
    btn.disabled = false;
    btn.textContent = "Adicionar à agenda";
  }
}

function saveTime(form: HTMLFormElement): void {
  const data = new FormData(form);
  send({
    type: "updateEvent",
    eventId: form.dataset.id ?? "",
    date: String(data.get("date") ?? ""),
    start: String(data.get("start") ?? ""),
    end: String(data.get("end") ?? ""),
  });
  toast("Dia e horário salvos.");
}

// ---------- eventos de clique / formulário ----------

document.addEventListener("click", (e) => {
  const target = e.target as HTMLElement;

  // clique no fundo escuro do modal fecha
  if (target.id === "modal") {
    closeModal();
    return;
  }

  const el = target.closest<HTMLElement>("[data-action]");
  if (!el) return;
  const action = el.dataset.action;
  const id = el.dataset.id ?? "";

  switch (action) {
    case "view":
      view = el.dataset.view as typeof view;
      render();
      break;

    case "day":
      selectedDay = el.dataset.day ?? selectedDay;
      render();
      break;

    case "mode":
      listMode = el.dataset.mode as ListKind;
      render();
      break;

    case "toggle-search":
      searchOpen = !searchOpen;
      if (!searchOpen) search = "";
      render();
      break;

    case "open":
      modal = { kind: "event", id };
      renderModal();
      break;

    case "close":
      closeModal();
      break;

    case "vote":
      e.stopPropagation();
      vote(id);
      break;

    case "reserve":
      reserve(id);
      break;

    case "close-voting":
      closeVoting(el.dataset.date ?? selectedDay);
      break;

    case "copy-agenda":
      void copyText(location.href, "Link da agenda copiado!");
      break;

    case "copy-link":
      void copyText(el.dataset.link ?? "", "Link do evento copiado!");
      break;

    case "remove":
      if (confirm("Excluir este evento para todo mundo?")) {
        send({ type: "removeEvent", eventId: id });
        closeModal();
      }
      break;

    case "new-event":
      modal = { kind: "form" };
      showModal(linkForm(), "form");
      requestAnimationFrame(() => document.querySelector<HTMLInputElement>('input[name="link"]')?.focus());
      break;
  }
});

document.addEventListener("submit", (e) => {
  const form = e.target as HTMLFormElement;
  const kind = form.dataset.form;
  if (!kind) return;
  e.preventDefault();
  if (kind === "link") void addByLink(form);
  if (kind === "time") saveTime(form);
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && modal) closeModal();
});

// ---------- tempo real (WebSocket) ----------

function connect(): void {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  socket = new WebSocket(`${proto}://${location.host}/ws`);

  socket.onopen = () => {
    online = true;
    render();
  };

  socket.onmessage = (ev: MessageEvent<string>) => {
    const msg = JSON.parse(ev.data) as ServerMessage;
    if (msg.type === "state") {
      const before = new Set(
        Object.entries(state.reserved)
          .filter(([, origin]) => origin === "votacao")
          .map(([id]) => id),
      );
      state = msg.state;
      loaded = true;
      // avisa quando um evento acabou de ganhar a votação
      for (const [id, origin] of Object.entries(state.reserved)) {
        const ev = state.events.find((e) => e.id === id);
        if (origin === "votacao" && ev && previouslyLoaded && !before.has(id)) {
          toast(`🏆 "${ev.title}" venceu a votação e foi para Reservados!`);
        }
      }
      previouslyLoaded = true;
      render();
    } else {
      toast(msg.message);
    }
  };

  socket.onclose = () => {
    online = false;
    render();
    window.setTimeout(connect, 1500);
  };
}

render();
connect();
