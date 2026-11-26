export interface CivilService {
  id: string;
  title: string;
}

export const CIVIL_SERVICES: readonly CivilService[] = [
  { id: "basic-pension", title: "기초연금 신청(모의)" },
  { id: "resident-copy", title: "주민등록표 등본 발급(모의)" },
  { id: "disability-taxi", title: "장애인 콜택시 이용 등록(모의)" },
];

const byId = new Map(CIVIL_SERVICES.map((service) => [service.id, service]));

export function findCivilService(id: string): CivilService | undefined {
  return byId.get(id);
}
