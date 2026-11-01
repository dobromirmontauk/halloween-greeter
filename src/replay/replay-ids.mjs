// Visit id check without importing the recorder (keeps replay-manager free of import cycles).
export const validVisitIdLocal=id=>typeof id==='string'&&/^\d{8}-\d{6}-[a-f0-9]{6}$/.test(id);
