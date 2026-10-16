import json, math, subprocess, wave
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent
DATA = json.loads((ROOT / 'content.json').read_text())
W,H,FPS = 1280,720,24
NAVY='#0B2342'; BLUE='#1265ED'; TEAL='#007F7A'; WHITE='#FFFFFF'; INK='#182E49'; MUTED='#52677F'; BG='#F2F6FC'
def font(n,bold=False): return ImageFont.truetype('C:/Windows/Fonts/'+('segoeuib.ttf' if bold else 'segoeui.ttf'),n)
FONTS={}
def f(n,b=False):
    if (n,b) not in FONTS: FONTS[n,b]=font(n,b)
    return FONTS[n,b]
def txt(d,xy,s,n=24,c=INK,b=False): d.text(xy,s,font=f(n,b),fill=c)
def box(d,xy,fill=WHITE,outline=None,r=20): d.rounded_rectangle(xy,r,fill=fill,outline=outline,width=2)
def wrapped(d,s,x,y,width,n=24,c=INK,b=False,gap=7):
    lines=[]; line=''
    for word in s.split():
        new=(line+' '+word).strip()
        if d.textlength(new,font=f(n,b))>width and line: lines.append(line); line=word
        else: line=new
    if line: lines.append(line)
    for line in lines: txt(d,(x,y),line,n,c,b); y+=n+gap
    return y
def arrow(d,x1,y1,x2,y2,c=BLUE):
    d.line((x1,y1,x2,y2),fill=c,width=4)
    d.polygon([(x2,y2),(x2-12,y2-7),(x2-12,y2+7)],fill=c)
def mail(d,x,y,c=BLUE):
    d.rounded_rectangle((x,y,x+44,y+30),5,outline=c,width=3)
    d.line((x,y,x+22,y+17,x+44,y),fill=c,width=3)
def card(d,x,y,w,h,kicker,title,body='',accent=BLUE):
    box(d,(x,y,x+w,y+h)); txt(d,(x+24,y+21),kicker,15,accent,True)
    yy=wrapped(d,title,x+24,y+53,w-48,27,INK,True)
    if body: wrapped(d,body,x+24,yy+14,w-48,21,MUTED)
def tag(d,x,y,label,color=TEAL):
    width=d.textlength(label,font=f(17,True))+28
    box(d,(x,y,x+width,y+33),color,r=16); txt(d,(x+14,y+4),label,17,WHITE,True)
def base(i,t):
    im=Image.new('RGB',(W,H),BG); d=ImageDraw.Draw(im)
    d.rectangle((0,0,W,8),fill=BLUE)
    txt(d,(52,30),'SPREAD',23,NAVY,True)
    txt(d,(179,36),' /  EMAIL-TO-ORDER AGENT',15,MUTED,True)
    txt(d,(1084,36),'EXPLAINER',14,MUTED,True)
    title=DATA[i]['title']; n=43 if i!=5 else 37
    txt(d,(52,99),title,n,NAVY,True)
    subtitles=['Turn shipping instructions into structured warehouse orders.',
        'Customer, forwarder, and factory communications in one workflow.',
        'Identify intent and extract the details needed for the order.',
        'Keep incomplete information and failed requests visible.',
        'Convert validated shipping instructions into a warehouse order.',
        'Bring the same order creation workflow across warehouses.']
    txt(d,(54,161),subtitles[i],23,MUTED)
    d.rectangle((0,611,W,H),fill=NAVY)
    sentences=DATA[i]['narration'].split('. ')
    narration=DATA[i]['narration']
    # Two caption cues per scene, with line breaks based on available width.
    words=narration.split(); half=(len(words)+1)//2
    caption=' '.join(words[:half] if t<5 else words[half:])
    wrapped(d,caption,67,632,1146,24,WHITE,gap=5)
    d.rectangle((0,714,int(W*(i*10+t)/60),719),fill='#38D9CC')
    return im,d
def scene(i,t):
    im,d=base(i,t)
    pulse=int((t*0.7)%3)
    if i==0:
        for j,(title,body) in enumerate([('Shipping emails','Instructions arrive'),('Email-to-Order Agent','Read • Validate • Create'),('WMS orders','Ready for operations')]):
            x=52+j*408
            card(d,x,255,360,230,['INPUT','AUTOMATION','OUTPUT'][j],title,body,TEAL if j==2 else BLUE)
            if j==pulse: d.rounded_rectangle((x,255,x+360,485),20,outline=BLUE,width=3)
            if j<2: arrow(d,x+369,370,x+398,370)
        tag(d,52,526,'INBOUND'); tag(d,179,526,'OUTBOUND')
        txt(d,(365,531),'Less repetitive data entry for your team',23,MUTED)
    elif i==1:
        for j,(title,body) in enumerate([('Customers','Call-offs / Purchase orders'),('Freight forwarders','Shipping instructions'),('Factory sites','Inbound delivery advice')]):
            y=225+j*112; box(d,(52,y,615,y+96)); mail(d,76,y+30)
            txt(d,(141,y+15),title,25,INK,True); txt(d,(141,y+51),body,21,MUTED)
            arrow(d,630,y+48,747,389)
        card(d,765,275,460,237,'EMAIL-TO-ORDER AGENT','Read incoming instructions','Recognize the sender context and the requested warehouse activity.')
    elif i==2:
        card(d,52,231,347,326,'01 / UNDERSTAND','Identify shipping intent','Interpret call-offs, purchase orders, inbound advice, and outbound shipping instructions.')
        arrow(d,414,388,456,388)
        box(d,(475,231,1227,557)); txt(d,(501,254),'EXTRACT KEY ORDER DETAILS',17,BLUE,True)
        for j,(a,b) in enumerate([('PO number','PO-10482'),('Part number','PART-028'),('Quantity','120 units'),('Destination','Mexico warehouse')]):
            yy=298+j*53
            txt(d,(501,yy),a,23,MUTED); txt(d,(826,yy),b,23,INK,True)
            if j<3: d.line((501,yy+42,1198,yy+42),fill='#DFE7F1',width=1)
        txt(d,(956,574),'Illustrative data',15,MUTED)
    elif i==3:
        card(d,52,245,350,286,'VALIDATION','Check required details','Validate order data before creating the WMS order.')
        arrow(d,416,383,455,383)
        card(d,475,228,751,151,'MISSING INFORMATION','Request the missing details','Help the sender complete the order information.',accent='#A66C00')
        card(d,475,403,751,151,'CREATION FAILURE','Notify the team','Make unsuccessful requests visible for follow-up.',accent='#B14350')
    elif i==4:
        box(d,(52,230,851,566)); txt(d,(79,251),'WMS / ORDER OVERVIEW',17,BLUE,True)
        cols=[79,316,488,674]
        for x,label in zip(cols,['Order','Type','Warehouse','Status']): txt(d,(x,304),label,19,MUTED,True)
        for j,row in enumerate([('IN-001','Inbound','Mexico','Created'),('OUT-002','Outbound','Mexico','Created')]):
            y=354+j*74; box(d,(72,y-9,828,y+50),'#EFF5FD',r=9)
            for x,label in zip(cols[:3],row[:3]): txt(d,(x,y),label,23,INK,True)
            tag(d,cols[3],y,row[3])
        txt(d,(79,529),'Illustrative interface and order data',16,MUTED)
        card(d,880,230,347,336,'ORDER CREATED','Send confirmation','The warehouse team can prepare for receiving or shipping.',TEAL)
    else:
        for j,(title,body) in enumerate([('Faster order creation','Reduce repetitive entry'),('Fewer input errors','Reduce manual mistakes'),('Cross-warehouse automation','Reuse the order workflow')]):
            card(d,52+j*408,235,360,202,'BENEFIT '+str(j+1),title,body,TEAL)
        box(d,(52,467,1227,571),NAVY)
        txt(d,(78,485),'SUPPORTED SCOPE',15,'#64DDD6',True)
        txt(d,(78,517),'Crane customers  /  Mexico warehouse transfers  /  Second Mexico warehouse',24,WHITE)
    # Animated progress dots provide a consistent visual cue.
    for j in range(6):
        d.ellipse((1100+j*20,85,1108+j*20,93),fill=BLUE if j==i else '#CCD9E9')
    return im

def infographic():
    im=Image.new('RGB',(1600,1100),BG); d=ImageDraw.Draw(im)
    d.rectangle((0,0,1600,12),fill=BLUE)
    txt(d,(64,48),'SPREAD  /  AUTOMATED WAREHOUSE WORKFLOWS',21,BLUE,True)
    txt(d,(64,105),'Email-to-Order Agent',70,NAVY,True)
    txt(d,(67,202),'Turn shipping emails into WMS orders automatically.',33,MUTED)
    for j,(k,a,b) in enumerate([('01 / RECEIVE','Shipping emails','Customers, freight forwarders, and factory sites'),('02 / PROCESS','Read, understand, validate','Identify inbound / outbound intent and extract order details'),('03 / CREATE','WMS orders','Create warehouse orders and send confirmation')]):
        x=64+j*506; card(d,x,291,460,245,k,a,b,TEAL if j==2 else BLUE)
        if j<2: arrow(d,x+468,414,x+494,414)
    card(d,64,574,714,205,'EXCEPTION HANDLING','Keep the team informed','Request missing information and notify the team when order creation fails.',accent='#A66C00')
    card(d,808,574,728,205,'CROSS-WAREHOUSE SUPPORT','Connect warehouse operations','Crane customers, Mexico warehouse transfers, and a second warehouse in Mexico.',accent=TEAL)
    box(d,(64,824,1536,1025),NAVY)
    txt(d,(91,849),'BUILT TO REDUCE REPETITIVE MANUAL WORK',20,'#64DDD6',True)
    for x,title,body in [(91,'Faster','Shorter order creation time'),(581,'More accurate','Fewer manual input errors'),(1071,'More connected','Cross-warehouse automation')]:
        txt(d,(x,898),title,34,WHITE,True); txt(d,(x,950),body,22,'#D7E6FC')
    im.save(ROOT/'email-to-order-infographic.png')

def main():
    infographic()
    audio=[]
    for i in range(6):
        src=ROOT/f'voice-{i}.wav'
        with wave.open(str(src)) as wav: dur=wav.getnframes()/wav.getframerate()
        rate=max(1,dur/9.35)
        dest=ROOT/f'audio-{i}.wav'
        subprocess.run(['ffmpeg','-y','-v','error','-i',str(src),'-af',f'atempo={rate},apad','-t','10','-ar','48000','-ac','1',str(dest)],check=True)
        audio.append(dest)
    (ROOT/'audio-list.txt').write_text('\n'.join("file '"+p.name+"'" for p in audio))
    subprocess.run(['ffmpeg','-y','-v','error','-f','concat','-safe','0','-i',str(ROOT/'audio-list.txt'),'-c:a','pcm_s16le',str(ROOT/'narration.wav')],check=True)
    cmd=['ffmpeg','-y','-v','error','-f','rawvideo','-vcodec','rawvideo','-pix_fmt','rgb24','-s','1280x720','-r',str(FPS),'-i','-','-i',str(ROOT/'narration.wav'),'-c:v','libx264','-preset','fast','-crf','19','-pix_fmt','yuv420p','-c:a','aac','-b:a','160k','-movflags','+faststart','-shortest',str(ROOT/'email-to-order-agent.mp4')]
    proc=subprocess.Popen(cmd,stdin=subprocess.PIPE)
    for i in range(6):
        for frame in range(10*FPS): proc.stdin.write(scene(i,frame/FPS).tobytes())
        scene(i,4).save(ROOT/f'scene-{i+1}.png')
        print('Rendered scene',i+1,flush=True)
    proc.stdin.close()
    if proc.wait(): raise RuntimeError('Video render failed')
    contact=Image.new('RGB',(960,810),BG)
    for i in range(6):
        thumb=scene(i,4).resize((480,270))
        contact.paste(thumb,((i%2)*480,(i//2)*270))
    contact.save(ROOT/'storyboard.jpg')
    def stamp(t): return f'00:00:{t:02d},000' if t<60 else '00:01:00,000'
    cues=[]
    for i,row in enumerate(DATA):
        words=row['narration'].split(); half=(len(words)+1)//2
        for k,part in enumerate([words[:half],words[half:]]):
            cues.append(f'{i*2+k+1}\n{stamp(i*10+k*5)} --> {stamp(i*10+(k+1)*5)}\n'+ ' '.join(part))
    (ROOT/'captions-en.srt').write_text('\n\n'.join(cues),encoding='utf-8')
    (ROOT/'script-en.md').write_text('# Email-to-Order Agent\n\n60-second product explainer. All interfaces and order data are illustrative.\n\n'+'\n\n'.join(f'## {i*10:02d}-{(i+1)*10:02d}s: {row["title"]}\n\n{row["narration"]}' for i,row in enumerate(DATA)),encoding='utf-8')
if __name__=='__main__': main()
