type WardrobeSide='left'|'right';
export type WardrobeItem={id:string;name:string;imageUrl:string|null;thumbnailUrl?:string|null;assetType?:'2d'|'3d';hasModel:boolean};
type Card={button:HTMLButtonElement;image:HTMLImageElement;imageUrl:string|null|undefined;fallbackUrl:string|null};

/** Keep decoded image nodes mounted when selecting or refreshing the wardrobe. */
export function createWardrobeRenderer(panels:Record<WardrobeSide,HTMLElement>,onSelect:(id:string)=>void){
  const cards=new Map<string,Card>();
  let selectedId:string|null=null;
  function setSelected(id:string|null|undefined){
    const next=id&&cards.has(id)?id:null;
    if(next===selectedId)return;
    const scrolls=Object.values(panels).map(panel=>({panel,top:panel.scrollTop,left:panel.scrollLeft}));
    for(const [cardId,selected] of [[selectedId,false],[next,true]] as const){
      const card=cardId?cards.get(cardId):undefined;
      if(card){card.button.classList.toggle('selected',selected);card.button.setAttribute('aria-pressed',String(selected));}
    }
    selectedId=next;
    for(const {panel,top,left} of scrolls){panel.scrollTop=top;panel.scrollLeft=left;}
  }
  function sync(items:readonly WardrobeItem[],selection:string|null|undefined){
    const scrolls=Object.entries(panels).map(([side,panel])=>({side:side as WardrobeSide,top:panel.scrollTop,left:panel.scrollLeft}));
    const present=new Set(items.map(item=>item.id));
    for(const [id,card] of cards)if(!present.has(id)){card.button.remove();cards.delete(id);}
    const desired:Record<WardrobeSide,HTMLButtonElement[]>={left:[],right:[]};
    for(const [index,item] of items.entries()){
      // Keep the API ranking row-wise: first left, second right, and so on.
      const side:WardrobeSide=index%2===0?'left':'right';
      let card=cards.get(item.id);
      if(!card){
        const document=panels[side].ownerDocument;
        const button=document.createElement('button'),image=document.createElement('img');
        button.type='button';button.className='garment-card';button.dataset.garmentId=item.id;button.setAttribute('aria-pressed','false');
        image.alt='';image.loading='lazy';image.decoding='async';button.append(image);
        button.onclick=()=>onSelect(item.id);
        card={button,image,imageUrl:undefined,fallbackUrl:item.imageUrl};cards.set(item.id,card);
        image.onerror=()=>{
          const fallback=card!.fallbackUrl;
          if(fallback&&image.getAttribute('src')!==fallback)image.setAttribute('src',fallback);
        };
      }
      if(card.button.getAttribute('aria-label')!==item.name)card.button.setAttribute('aria-label',item.name);
      const imageUrl=item.thumbnailUrl||item.imageUrl;
      const fallbackChanged=card.fallbackUrl!==item.imageUrl&&card.image.getAttribute('src')===card.fallbackUrl;
      card.fallbackUrl=item.imageUrl;
      if(card.imageUrl!==imageUrl){
        if(imageUrl)card.image.setAttribute('src',imageUrl);else card.image.removeAttribute('src');
        card.imageUrl=imageUrl;
      }else if(fallbackChanged){
        if(item.imageUrl)card.image.setAttribute('src',item.imageUrl);else card.image.removeAttribute('src');
      }
      desired[side].push(card.button);
    }
    for(const side of ['left','right'] as const){
      const panel=panels[side];let cursor=panel.firstElementChild;
      for(const button of desired[side]){
        if(button!==cursor)panel.insertBefore(button,cursor);
        cursor=button.nextElementSibling;
      }
    }
    setSelected(selection);
    for(const position of scrolls){const panel=panels[position.side];panel.scrollTop=position.top;panel.scrollLeft=position.left;}
  }
  return {sync,setSelected};
}
