// Deutsche Wortlisten für Draw & Guess.
// Wird sowohl vom Frontend (Solo) als auch vom Server (Duell) importiert.

export const WORDS = {
  tiere: [
    "Katze", "Hund", "Elefant", "Giraffe", "Schmetterling", "Fisch", "Vogel",
    "Schlange", "Spinne", "Pinguin", "Schildkröte", "Krokodil", "Biene",
    "Eule", "Pferd", "Kuh", "Schwein", "Maus", "Hase", "Löwe", "Affe",
    "Frosch", "Ente", "Schnecke", "Igel", "Wal", "Hai", "Krebs", "Qualle",
  ],
  objekte: [
    "Haus", "Auto", "Fahrrad", "Brille", "Uhr", "Schlüssel", "Schere",
    "Regenschirm", "Gitarre", "Klavier", "Lampe", "Stuhl", "Tisch", "Buch",
    "Handy", "Fernseher", "Flugzeug", "Schiff", "Rakete", "Ballon",
    "Kerze", "Hammer", "Leiter", "Zelt", "Brücke", "Windmühle", "Ampel",
    "Herd", "Toaster", "Zahnbürste", "Koffer", "Krone", "Schwert", "Anker",
  ],
  natur: [
    "Sonne", "Mond", "Stern", "Wolke", "Regenbogen", "Blitz", "Baum",
    "Blume", "Kaktus", "Pilz", "Berg", "Vulkan", "Insel", "Welle",
    "Schneemann", "Feuer", "Tornado", "Apfel", "Banane", "Erdbeere",
    "Karotte", "Kürbis", "Ananas", "Zitrone",
  ],
  essen: [
    "Pizza", "Burger", "Eis", "Kuchen", "Brezel", "Spiegelei", "Donut",
    "Croissant", "Sushi", "Pommes", "Käse", "Brot", "Wurst", "Muffin",
  ],
  aktivitäten: [
    "Schwimmen", "Tanzen", "Schlafen", "Angeln", "Fußball", "Skifahren",
    "Klettern", "Lesen", "Kochen", "Singen", "Boxen", "Jonglieren",
    "Reiten", "Surfen",
  ],
  schwer: [
    "Freiheit", "Traum", "Musik", "Winter", "Urlaub", "Geburtstag",
    "Zeitreise", "Schwerkraft", "Echo", "Gewitter", "Zirkus", "Museum",
    "Baustelle", "Flughafen", "Karneval", "Weltraum",
  ],
};

export const CATEGORIES = Object.keys(WORDS);

export function allWords() {
  return CATEGORIES.flatMap((c) => WORDS[c]);
}

export function pickWord(category = "alle", exclude = []) {
  const pool = (category === "alle" ? allWords() : WORDS[category] || allWords())
    .filter((w) => !exclude.includes(w));
  const list = pool.length ? pool : allWords();
  return list[Math.floor(Math.random() * list.length)];
}
