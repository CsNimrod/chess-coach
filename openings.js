// Opening repertoire. `side` = the side you usually train. `match` = words that link
// openings found in your chess.com games to this group.
export const OPENINGS = [
  {
    id: 'italian', name: 'Italian Game', side: 'w', match: ['Italian', 'Giuoco', 'Two Knights', 'Evans'],
    desc: 'Bc4 aiming at f7. Quiet c3/d3 setups or sharp d4 breaks.',
    lines: [
      { name: 'Giuoco Pianissimo', moves: 'e4 e5 Nf3 Nc6 Bc4 Bc5 c3 Nf6 d3 d6 O-O O-O Re1 a6 a4' },
      { name: 'Giuoco Piano main line (c3 + d4)', moves: 'e4 e5 Nf3 Nc6 Bc4 Bc5 c3 Nf6 d4 exd4 cxd4 Bb4+ Bd2 Bxd2+ Nbxd2 d5 exd5 Nxd5 Qb3' },
      { name: 'Two Knights, quiet d3', moves: 'e4 e5 Nf3 Nc6 Bc4 Nf6 d3 Be7 O-O O-O Re1 d6 c3' },
      { name: 'Two Knights, Ng5 main line', moves: 'e4 e5 Nf3 Nc6 Bc4 Nf6 Ng5 d5 exd5 Na5 Bb5+ c6 dxc6 bxc6 Be2 h6 Nf3 e4 Ne5' },
      { name: 'Evans Gambit', moves: 'e4 e5 Nf3 Nc6 Bc4 Bc5 b4 Bxb4 c3 Ba5 d4 exd4 O-O Nge7 cxd4 d5 exd5 Nxd5' },
    ],
  },
  {
    id: 'ruy', name: 'Ruy Lopez', side: 'w', match: ['Ruy Lopez', 'Spanish'],
    desc: 'Bb5 pressure on the e5 defender. Long-term strategic squeeze.',
    lines: [
      { name: 'Closed main line', moves: 'e4 e5 Nf3 Nc6 Bb5 a6 Ba4 Nf6 O-O Be7 Re1 b5 Bb3 d6 c3 O-O h3' },
      { name: 'Berlin endgame', moves: 'e4 e5 Nf3 Nc6 Bb5 Nf6 O-O Nxe4 d4 Nd6 Bxc6 dxc6 dxe5 Nf5 Qxd8+ Kxd8' },
      { name: 'Exchange variation', moves: 'e4 e5 Nf3 Nc6 Bb5 a6 Bxc6 dxc6 O-O f6 d4 exd4 Nxd4 c5 Nb3' },
    ],
  },
  {
    id: 'sicilian', name: 'Sicilian Defense', side: 'b', match: ['Sicilian'],
    desc: 'c5 fights for d4 asymmetrically. Black plays for a win.',
    lines: [
      { name: 'Najdorf, English Attack', moves: 'e4 c5 Nf3 d6 d4 cxd4 Nxd4 Nf6 Nc3 a6 Be3 e5 Nb3 Be6 f3 Be7 Qd2 O-O O-O-O Nbd7' },
      { name: 'Najdorf, 6.Bg5', moves: 'e4 c5 Nf3 d6 d4 cxd4 Nxd4 Nf6 Nc3 a6 Bg5 e6 f4 Be7 Qf3 Qc7 O-O-O Nbd7' },
      { name: 'vs Alapin (2.c3)', moves: 'e4 c5 c3 Nf6 e5 Nd5 d4 cxd4 Nf3 Nc6 cxd4 d6 Bc4 Nb6 Bb5' },
      { name: 'vs Rossolimo (3.Bb5)', moves: 'e4 c5 Nf3 Nc6 Bb5 g6 O-O Bg7 Re1 e5 Bxc6 dxc6 d3 Qc7' },
    ],
  },
  {
    id: 'french', name: 'French Defense', side: 'b', match: ['French'],
    desc: 'e6 + d5: solid pawn chain, counterattack with ...c5 and ...f6.',
    lines: [
      { name: 'Advance variation', moves: 'e4 e6 d4 d5 e5 c5 c3 Nc6 Nf3 Qb6 a3 c4 Nbd2 Na5' },
      { name: 'Winawer', moves: 'e4 e6 d4 d5 Nc3 Bb4 e5 c5 a3 Bxc3+ bxc3 Ne7 Qg4 Qc7' },
      { name: 'Exchange variation', moves: 'e4 e6 d4 d5 exd5 exd5 Nf3 Bd6 Bd3 Ne7 O-O O-O' },
    ],
  },
  {
    id: 'caro', name: 'Caro-Kann Defense', side: 'b', match: ['Caro Kann', 'Caro-Kann'],
    desc: 'c6 + d5: solid, with a good light-squared bishop.',
    lines: [
      { name: 'Classical', moves: 'e4 c6 d4 d5 Nc3 dxe4 Nxe4 Bf5 Ng3 Bg6 h4 h6 Nf3 Nd7 h5 Bh7 Bd3 Bxd3 Qxd3 e6' },
      { name: 'Advance variation', moves: 'e4 c6 d4 d5 e5 Bf5 Nf3 e6 Be2 c5 Be3' },
      { name: 'Exchange variation', moves: 'e4 c6 d4 d5 exd5 cxd5 Bd3 Nc6 c3 Nf6 Bf4 Bg4 Qb3 Qd7' },
    ],
  },
  {
    id: 'scandi', name: 'Scandinavian Defense', side: 'b', match: ['Scandinavian'],
    desc: '1...d5 hits e4 straight away. Easy to learn and gets a quick fight.',
    lines: [
      { name: 'Main line ...Qa5', moves: 'e4 d5 exd5 Qxd5 Nc3 Qa5 d4 Nf6 Nf3 c6 Bc4 Bf5 Bd2 e6' },
      { name: 'Modern ...Qd6', moves: 'e4 d5 exd5 Qxd5 Nc3 Qd6 d4 Nf6 Nf3 a6 g3 Bg4' },
    ],
  },
  {
    id: 'qg', name: "Queen's Gambit", side: 'w', match: ['Queens Gambit', "Queen's Gambit", 'Slav'],
    desc: 'c4 against d5. Classic central pressure.',
    lines: [
      { name: 'QGD Tartakower', moves: 'd4 d5 c4 e6 Nc3 Nf6 Bg5 Be7 e3 O-O Nf3 h6 Bh4 b6' },
      { name: 'Queen\'s Gambit Accepted', moves: 'd4 d5 c4 dxc4 Nf3 Nf6 e3 e6 Bxc4 c5 O-O a6' },
      { name: 'Slav main line', moves: 'd4 d5 c4 c6 Nf3 Nf6 Nc3 dxc4 a4 Bf5 e3 e6 Bxc4 Bb4 O-O' },
    ],
  },
  {
    id: 'london', name: 'London System', side: 'w', match: ['London'],
    desc: 'd4 + Bf4 + e3 + c3. Same setup against almost anything.',
    lines: [
      { name: 'vs ...d5 & ...c5', moves: 'd4 d5 Bf4 Nf6 e3 e6 Nf3 c5 c3 Nc6 Nbd2 Bd6 Bg3 O-O Bd3' },
      { name: 'vs King\'s Indian setup', moves: 'd4 Nf6 Bf4 g6 e3 Bg7 Nf3 O-O Be2 d6 h3 c5 c3' },
    ],
  },
  {
    id: 'kid', name: "King's Indian Defense", side: 'b', match: ['Kings Indian', "King's Indian"],
    desc: 'Let White build a center, then hit it with ...e5 and a kingside attack.',
    lines: [
      { name: 'Classical, Mar del Plata', moves: 'd4 Nf6 c4 g6 Nc3 Bg7 e4 d6 Nf3 O-O Be2 e5 O-O Nc6 d5 Ne7' },
      { name: 'Sämisch', moves: 'd4 Nf6 c4 g6 Nc3 Bg7 e4 d6 f3 O-O Be3 e5 d5 Nh5' },
    ],
  },
  {
    id: 'e5black', name: '1.e4 e5 as Black', side: 'b', match: ['Kings Pawn', 'Petrov', 'Philidor', 'Scotch', 'Vienna'],
    desc: 'Answering 1.e4 with 1...e5 against the main tries.',
    lines: [
      { name: 'vs Italian: Giuoco Pianissimo', moves: 'e4 e5 Nf3 Nc6 Bc4 Bc5 c3 Nf6 d3 d6 O-O a6 a4 O-O' },
      { name: 'vs Scotch', moves: 'e4 e5 Nf3 Nc6 d4 exd4 Nxd4 Nf6 Nxc6 bxc6 e5 Qe7 Qe2 Nd5 c4 Ba6' },
      { name: 'vs Vienna', moves: 'e4 e5 Nc3 Nf6 f4 d5 fxe5 Nxe4 Nf3 Be7' },
      { name: 'Petrov main line', moves: 'e4 e5 Nf3 Nf6 Nxe5 d6 Nf3 Nxe4 d4 d5 Bd3 Nc6 O-O Be7' },
    ],
  },
];

export const lineKey = (gid, li) => `${gid}:${li}`;
export function parseMoves(text) {
  return text.replace(/\{[^}]*\}/g, ' ').replace(/\d+\.(\.\.)?/g, ' ').split(/\s+/).filter((t) => t && !/^(1-0|0-1|1\/2-1\/2|\*)$/.test(t));
}
