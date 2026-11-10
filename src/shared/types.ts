/** Perfil único compartilhado pelo grupo (sem cadastro). */
export const GROUP_NAME = "Amigos da Computaria";

export interface Speaker {
  name: string;
  role?: string;
}

export interface AgendaEvent {
  id: string;
  date: string; // YYYY-MM-DD
  start: string; // HH:MM ou "" (a definir)
  end: string; // HH:MM ou ""
  title: string;
  description: string;
  format: string;
  audience: string;
  access: string;
  organizer: string;
  speakers: Speaker[];
  location: string;
  address: string;
  tags: string[];
  /** Link oficial do evento (share.jalanlive.com), vazio se não houver */
  link: string;
  /** Imagem oficial do evento (og:image), vazia se não houver */
  image: string;
}

export interface AgendaState {
  events: AgendaEvent[];
  /** eventId -> ids dos navegadores que votaram (um voto por navegador por dia) */
  votes: Record<string, string[]>;
  /** eventId -> "votacao": o mais votado do dia, reservado na data do evento */
  reserved: Record<string, "votacao">;
}

export type ListKind = "favorites" | "reserved";

export type ClientMessage =
  | { type: "vote"; eventId: string; voterId: string }
  | { type: "addEvent"; event: Omit<AgendaEvent, "id"> }
  | { type: "updateEvent"; eventId: string; date: string; start: string; end: string };

export type ServerMessage =
  | { type: "state"; state: AgendaState }
  | { type: "error"; message: string };
