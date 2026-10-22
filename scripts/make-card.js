// lunamap share card and icons: Tasmania outline (Natural Earth 10 m land, via the world-atlas
// npm package; extract the rings near Tasmania to tas.json first) on a faint grid, with a grid-square
// bracket at Fern Tree. Writes card.svg and icon512.svg; render to PNG with any headless browser.
const fs=require('fs'); const rings=JSON.parse(fs.readFileSync('tas.json'));
const LAT0=-42, k=Math.cos(LAT0*Math.PI/180);
// view box in lon/lat (main island + Flinders/King), centre and scale chosen per output
function svg(W,H,opt){
  const {cx,cy,deg,bg,grid,gridStep,land,coast,coastW,ringR,ringW,dotR,red,halo}=opt;
  const s=Math.min(W,H)/deg;                       // px per degree of latitude
  const X=lon=>W/2+(lon-cx)*k*s, Y=lat=>H/2-(lat-cy)*s;
  const path=rings.map(r=>'M'+r.map(([x,y])=>X(x).toFixed(1)+','+Y(y).toFixed(1)).join('L')+'Z').join('');
  let g=''; for(let x=(W/2)%gridStep;x<W;x+=gridStep) g+=`<line x1="${x}" x2="${x}" y1="0" y2="${H}"/>`;
  for(let y=(H/2)%gridStep;y<H;y+=gridStep) g+=`<line y1="${y}" y2="${y}" x1="0" x2="${W}"/>`;
  const tx=X(147.26), ty=Y(-42.92);               // Fern Tree / Hobart
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<rect width="${W}" height="${H}" fill="${bg}"/>
<g stroke="${grid}" stroke-width="${opt.gridW}">${g}</g>
<path d="${path}" fill="${land}" stroke="${coast}" stroke-width="${coastW}" stroke-linejoin="round"/>
${(()=>{const r=ringR,l=halo,w=ringW;let d='';
 for(const [sx,sy] of [[-1,-1],[1,-1],[1,1],[-1,1]]) d+=`M${tx+sx*r},${ty+sy*(r-l)}V${ty+sy*r}H${tx+sx*(r-l)}`;
 return `<path d="${d}" fill="none" stroke="${red}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"/>`+
  `<circle cx="${tx}" cy="${ty}" r="${dotR}" fill="${red}"/>`;})()}
</svg>`;}
const base={bg:'#fbfaf6',grid:'#9ec1e6',gridW:1.5,land:'#eef0e6',coast:'#7d8c80',red:'#b3261e'};
// share card: 1200x630; Tasmania centred so a square crop still holds it
fs.writeFileSync('card.svg',svg(1200,630,{...base,cx:146.6,cy:-41.9,deg:5.0,gridStep:105,coastW:2.2,ringR:22,ringW:3.5,dotR:4.5,halo:10}));
// icon: square, main island bigger, bolder strokes so it reads small
const ic={...base,grid:'#b3cdea',land:'#e6eadb',coast:'#6f7f72'};
fs.writeFileSync('icon512.svg',svg(512,512,{...ic,cx:146.55,cy:-42.0,deg:3.4,gridW:3,gridStep:128,coastW:6,ringR:38,ringW:9,dotR:9,halo:17}));
