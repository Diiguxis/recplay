import type { AgendaEvent, AgendaState } from "../shared/types.js";

/** Eventos iniciais (copiados dos prints). Adicione os demais pela própria página. */
export function seedState(): AgendaState {
  const events: AgendaEvent[] = [
    {
      id: "7961f3df-7192-4bb4-bd2b-a3ee705493a4",
      date: "2026-11-11",
      start: "10:00",
      end: "11:40",
      title: "CISSA Lab | Cibersegurança para Todos - 1",
      description:
        "O CISSA Lab é um programa de sensibilização em cibersegurança do CISSA/CESAR, voltado à comunidade em geral. Por meio de uma experiência presencial, prática e gamificada de 4 horas, introduz jovens, adultos e idosos aos conceitos essenciais de proteção digital — sem exigir conhecimento técnico prévio — contribuindo para a construção de uma sociedade digitalmente mais segura.",
      format: "Oficina",
      audience: "público geral",
      access: "por ordem de chegada",
      organizer: "CESAR",
      speakers: [
        { name: "Cassiel Kempa", role: "Pesquisador | CESAR" },
        { name: "Ana Luiza Motta" },
      ],
      location: "Cesar School - Bloco A - M003",
      address: "Avenida, Cais do Apolo, 77, Recife - PE, 50030-220",
      tags: ["Programação, Dados e Segurança Digital"],
      link: "https://share.jalanlive.com/recnplay2026?activityID=7961f3df-7192-4bb4-bd2b-a3ee705493a4",
      image: "https://static.jalanlive.com/public/imports/email-recnplay2026/image/90fa0d7c-23b2-42e5-aeee-7e31404cb16c.png",
    },
    {
      id: "tdc-stage-1",
      date: "2026-11-11",
      start: "10:00",
      end: "12:30",
      title: "TDC Stage - Engenharia de Software e IA",
      description: "",
      format: "",
      audience: "",
      access: "",
      organizer: "",
      speakers: [
        { name: "Stephany Henrique de Almeida Batista" },
        { name: "Paulo Calixto" },
        { name: "Nicole Bertolo" },
      ],
      location: "",
      address: "",
      tags: [],
      link: "",
      image: "",
    },
  ];

  return { events, votes: {}, reserved: {} };
}
