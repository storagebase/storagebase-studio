# -*- coding: utf-8 -*-
"""Baltaş Grubu / ARAS KARGO veri sızıntısı doğrulama raporu (PDF)."""
import os, re, datetime
from reportlab.lib.pagesizes import A4
from reportlab.lib.units import mm
from reportlab.lib import colors
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.enums import TA_LEFT, TA_JUSTIFY
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import (SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle,
                                HRFlowable, KeepTogether)

# ---------------- Fontlar (Türkçe destekli) ----------------
FDIR = "/System/Library/Fonts/Supplemental"
def reg(name, fname):
    p = os.path.join(FDIR, fname)
    if not os.path.exists(p):
        p = os.path.join("/Library/Fonts", fname)
    pdfmetrics.registerFont(TTFont(name, p))
reg("U",   "Arial.ttf")
reg("UB",  "Arial Bold.ttf")
reg("UI",  "Arial Italic.ttf")
reg("UBI", "Arial Bold Italic.ttf")
pdfmetrics.registerFontFamily("U", normal="U", bold="UB", italic="UI", boldItalic="UBI")

NAVY   = colors.HexColor("#1f2a44")
ACCENT = colors.HexColor("#2f6fb0")
GREEN  = colors.HexColor("#1b7f3b")
GREENB = colors.HexColor("#e5f3e8")
GREY   = colors.HexColor("#595959")
LIGHT  = colors.HexColor("#f2f5f9")
LINE   = colors.HexColor("#cdd6e2")

# ---------------- Biçimlendirme (tag-safe) ----------------
ALLOWED = re.compile(r"(</?b>|</?i>|</?sub>|</?super>|<br\s*/?>)", re.I)
def _esc(s): return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
def fmt(t):
    out, pos = [], 0
    for m in ALLOWED.finditer(t):
        out.append(_esc(t[pos:m.start()])); out.append(m.group(0)); pos = m.end()
    out.append(_esc(t[pos:]))
    return "".join(out)

def St(name, **kw):
    base = dict(fontName="U", textColor=colors.HexColor("#111"), fontSize=9.6,
                leading=13.4, alignment=TA_LEFT)
    base.update(kw)
    return ParagraphStyle(name, **base)

st_title = St("t",  fontSize=19, leading=23, textColor=colors.white, fontName="UB")
st_sub   = St("s",  fontSize=10.5, leading=14, textColor=colors.HexColor("#d6deeb"))
st_h1    = St("h1", fontSize=13, leading=16, textColor=NAVY, fontName="UB", spaceBefore=8, spaceAfter=2)
st_h2    = St("h2", fontSize=10.8, leading=14, textColor=ACCENT, fontName="UB", spaceBefore=7, spaceAfter=2)
st_body  = St("b",  alignment=TA_JUSTIFY)
st_call  = St("cl", alignment=TA_JUSTIFY)
st_small = St("sm", fontSize=8, leading=11, textColor=GREY)
st_cell  = St("c",  fontSize=7.7, leading=9.8)
st_cellb = St("cb", fontSize=7.7, leading=9.8, fontName="UB", textColor=NAVY)
st_bullet= St("bu", leftIndent=11, bulletIndent=1, alignment=TA_JUSTIFY)

def P(t, s=st_body): return Paragraph(fmt(t), s)
def B(t, s=st_bullet): return Paragraph("\u2022&nbsp;&nbsp;" + fmt(t), s)
def rule(color=LINE, th=0.5, sb=2, sa=5): return HRFlowable(width="100%", thickness=th, color=color, spaceBefore=sb, spaceAfter=sa)

DATE = datetime.date.today().strftime("%d.%m.%Y")
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                   "Baltas_Grubu_Veri_Sizintisi_Dogrulama_Raporu.pdf")
story = []

# ---------------- Kapak / başlık bloğu ----------------
head = Table(
    [[Paragraph("VERİ SIZINTISI DOĞRULAMA RAPORU", st_title)],
     [Paragraph("Baltaş Grubu dosya sunucusu sızıntısı — ARAS KARGO etkilenen klasörü", st_sub)],
     [Paragraph("SONUÇ: <b>DOĞRULANDI</b> — CTI listesindeki 23/23 kalem sızıntı ağacında birebir mevcut", St("x", fontSize=9, textColor=colors.white))]],
    colWidths=[174*mm])
head.setStyle(TableStyle([
    ("BACKGROUND",(0,0),(-1,-1), NAVY),
    ("LEFTPADDING",(0,0),(-1,-1),12),("RIGHTPADDING",(0,0),(-1,-1),12),
    ("TOPPADDING",(0,0),(-1,0),12),("TOPPADDING",(0,1),(-1,-1),2),
    ("BOTTOMPADDING",(0,-1),(-1,-1),10),
]))
story.append(head)
story.append(Spacer(1, 7))

meta = [
    ["Rapor tarihi", DATE, "Sınıflandırma", "TLP:AMBER / Kurum İçi"],
    ["Konu", "Açık kaynak sızıntı sayfasının doğrulanması", "Referans", "CTI Alarm Kodu 19918090 / 18228519"],
    ["Kapsam", "Dosya/dizin meta verisi doğrulaması", "Yöntem", "Kaynak dosya indirilmedi (yalnızca yayımlanan dizin verisi)"],
]
t = Table([[P(a, st_cellb), P(b, st_cell), P(c, st_cellb), P(d, st_cell)] for a,b,c,d in meta],
          colWidths=[23*mm, 56*mm, 21*mm, 62*mm])
t.setStyle(TableStyle([
    ("BACKGROUND",(0,0),(-1,-1), LIGHT), ("BOX",(0,0),(-1,-1),0.4,LINE),
    ("INNERGRID",(0,0),(-1,-1),0.3,colors.HexColor("#e2e8f1")),
    ("VALIGN",(0,0),(-1,-1),"TOP"),
    ("LEFTPADDING",(0,0),(-1,-1),5),("RIGHTPADDING",(0,0),(-1,-1),5),
    ("TOPPADDING",(0,0),(-1,-1),3),("BOTTOMPADDING",(0,0),(-1,-1),3),
]))
story.append(t)

# ---------------- 1 ----------------
story.append(Paragraph("1. Yönetici Özeti", st_h1)); story.append(rule())
story.append(P(
    "CTI (Siber Tehdit İstihbaratı) kanalından gelen veri sızıntısı bildirimi incelenmiştir. Bildirimde "
    "ARAS KARGO ile ilişkilendirilen <b>5 klasör ve 18 dosya</b> listelenmektedir. Yapılan doğrulamada bu "
    "kalemlerin tamamı, açık kaynak sızıntı sayfasının yayımladığı dosya ağacında <b>birebir ad ve byte "
    "boyutu ile</b> tespit edilmiştir (23/23). Hiçbir döküman içeriği indirilmemiş veya açılmamıştır."))
story.append(Spacer(1, 4))
crit = Table([[Paragraph(
    "<b>Kritik tespit:</b> Sızıntı yalnızca ARAS KARGO’yu kapsamamaktadır. Yayımlanan ağaç, "
    "<b>Baltaş Grubu</b> danışmanlık firmasının tüm dosya sunucusudur: yaklaşık <b>357.552 dosya</b>, "
    "<b>13.604 klasör</b> ve <b>264 müşteri/kurum</b>. ARAS KARGO bu ağaçta tek bir müşteri klasörüdür "
    "(548 dosya, 26 klasör). Olay, tek bir kuruma değil, bir <b>tedarikçi/danışman üzerinden çok sayıda "
    "kuruma</b> uzanan bir tedarik zinciri veri sızıntısıdır.", st_call)]],
    colWidths=[174*mm])
crit.setStyle(TableStyle([
    ("BACKGROUND",(0,0),(-1,-1), GREENB),
    ("LINEBEFORE",(0,0),(0,-1), 3, GREEN),
    ("LEFTPADDING",(0,0),(-1,-1),8),("RIGHTPADDING",(0,0),(-1,-1),8),
    ("TOPPADDING",(0,0),(-1,-1),6),("BOTTOMPADDING",(0,0),(-1,-1),6),
]))
story.append(crit)

# ---------------- 2 ----------------
story.append(Paragraph("2. Olay Arka Planı", st_h1)); story.append(rule())
story.append(P(
    "Bildirim, ARAS KARGO’nun pazarlama/ÇMA (çağrı merkezi) süreçlerine ilişkin anket, eğitim ve sunum "
    "dokümanlarının yetkisiz biçimde yayımlandığını iddia etmektedir. Dokümanların içerik ve adlandırma "
    "biçimi (Baltaş Grubu’na ait proje/şirket klasörleri), sızıntının kaynağının ARAS KARGO’nun kendi "
    "sistemleri değil, <b>danışman firma Baltaş Grubu’nun dosya sunucusu</b> olduğunu göstermektedir. "
    "Bu durum, veri sorumlusu/işleyen rollerinin ve bildirim yükümlülüğünün tedarikçi sözleşmeleri "
    "çerçevesinde değerlendirilmesini gerektirir."))

# ---------------- 3 ----------------
story.append(Paragraph("3. Kapsam ve Ölçek", st_h1)); story.append(rule())
scope = [
    ("Kök dizinler", "Baltaş Grubu - SEÇME  /  Baltaş Grubu - ÖLÇME"),
    ("Toplam dosya (tüm ağaç)", "~357.552"),
    ("Toplam klasör (tüm ağaç)", "~13.604"),
    ("Etkilenen şirket/kurum sayısı", "264"),
    ("ARAS KARGO alt ağacı — dosya", "548"),
    ("ARAS KARGO alt ağacı — klasör", "26"),
    ("ARAS KARGO alt ağacı — toplam düğüm", "574"),
]
t = Table([[P(a, st_cellb), P(b, st_cell)] for a,b in scope], colWidths=[62*mm, 112*mm])
t.setStyle(TableStyle([
    ("ROWBACKGROUNDS",(0,0),(-1,-1),[colors.white, LIGHT]),
    ("BOX",(0,0),(-1,-1),0.4,LINE), ("INNERGRID",(0,0),(-1,-1),0.25,colors.HexColor("#e2e8f1")),
    ("LEFTPADDING",(0,0),(-1,-1),5),("RIGHTPADDING",(0,0),(-1,-1),5),
    ("TOPPADDING",(0,0),(-1,-1),3),("BOTTOMPADDING",(0,0),(-1,-1),3),
]))
story.append(t)

# ---------------- 4 ----------------
story.append(Paragraph("4. Yöntem", st_h1)); story.append(rule())
for b in [
    "Sızıntı sayfasının yayımladığı dizin/meta verisi (<b>_browse.json</b> ve <b>_index.json</b>) alınmıştır; bunlar dosya <b>adı, yol ve boyut</b> bilgisidir, döküman içeriği değildir.",
    "CTI bildirimindeki liste ile sızıntı ağacı; normalize edilmiş ad ve byte boyutu üzerinden karşılaştırılmıştır.",
    "Erişim, ağdaki ad (SNI) filtresi nedeniyle doğrudan değil, sunucu tarafı bir okuyucu üzerinden sağlanmıştır.",
    "Hiçbir dosya içeriği indirilmemiş, açılmamış veya çalıştırılmamıştır; arşiv parolası kullanılmamıştır.",
]:
    story.append(B(b))

# ---------------- 5 ----------------
story.append(Paragraph("5. Bulgular", st_h1)); story.append(rule())
story.append(Paragraph("5.1  CTI listesi ↔ sızıntı ağacı eşleşmesi (23/23)", st_h2))
rows = [["CTI bildirimi (ad / boyut)", "Sızıntı ağacındaki gerçek ad", "Boyut", "Durum"]]
for f in ["ANKET SONUÇLARI","Ayşeşim Çalışma","ek çalışma(2015)","Gönderilen bilgiler","Nihat Çalışma"]:
    rows.append([f + " (Klasör)", f, "—", "✔"])
files = [
    ("X26484-5-8 ARALIK BALTAŞ EKİP LİSTESİ.xls","26484-5-8 ARALIK BALTAŞ EKİP LİSTESİ.xls","104 KB"),
    ("Xaçıkuçlusoru(kişisayıları).xlsx","açıkuçlusoru(kişisayıları).xlsx","18 KB"),
    ("PDFAras Kargo Anket.pdf","Aras Kargo Anket.pdf","4.25 MB"),
    ("WARAS KARGO ÇALIŞLAN MEMNUNİYETİ ANKETİ ONLİNE UYGULAMA TALİMATI.doc","ARAS KARGO ÇALIŞLAN MEMNUNİYETİ ANKETİ ONLİNE UYGULAMA TALİMATI.doc","78 KB"),
    ("XARAS KARGO ÇMA ŞİFRELER.xlsx","ARAS KARGO ÇMA ŞİFRELER.xlsx","307 KB"),
    ("PDFARAS KARGO ÇMA v7.pdf","ARAS KARGO ÇMA v7.pdf","4.63 MB"),
    ("XARAS KARGO ŞİFRE HAZIRLIK.xlsx","ARAS KARGO ŞİFRE HAZIRLIK.xlsx","1.42 MB"),
    ("PAras_Kargo_SUNUM_2013_Üst Yönetim Sunumu_DBE.ppt","Aras_Kargo_SUNUM_2013_Üst Yönetim Sunumu_DBE.ppt","10.6 MB"),
    ("Aras_Kargo_SUNUM_2013_Üst Yönetim Sunumu_DBE.rar","Aras_Kargo_SUNUM_2013_Üst Yönetim Sunumu_DBE.rar","9.0 MB"),
    ("PArasKargo(tanıtım).ppt","ArasKargo(tanıtım).ppt","1.0 MB"),
    ("XÇalışma Planı (2).xlsx","Çalışma Planı (2).xlsx","22 KB"),
    ("XKitapçık Listesi.xlsx","Kitapçık Listesi.xlsx","19 KB"),
    ("XKontrol Listesi.xlsx","Kontrol Listesi.xlsx","19 KB"),
    ("PDFMini Anket v2.pdf","Mini Anket v2.pdf","285 KB"),
    ("PSunum_ArasKargo.ppt","Sunum_ArasKargo.ppt","1.4 MB"),
    ("Xtransfer merkezleri.xlsx","transfer merkezleri.xlsx","19 KB"),
    ("XYapılacak Değişiklikler.xlsx","Yapılacak Değişiklikler.xlsx","18 KB"),
    ("XYetkinlik-Planı.xlsx","Yetkinlik-Planı.xlsx","25 KB"),
]
for a,b,c in files: rows.append([a,b,c,"✔"])
data = [[P(c, st_cellb if i==0 else (st_cell if j!=3 else St("ok",fontSize=8.5,textColor=GREEN,fontName="UB")))
         for j,c in enumerate(r)] for i,r in enumerate(rows)]
t = Table(data, colWidths=[77*mm, 73*mm, 14*mm, 10*mm], repeatRows=1)
t.setStyle(TableStyle([
    ("BACKGROUND",(0,0),(-1,0), NAVY),
    ("ROWBACKGROUNDS",(0,1),(-1,-1),[colors.white, LIGHT]),
    ("BOX",(0,0),(-1,-1),0.4,LINE), ("INNERGRID",(0,0),(-1,-1),0.25,colors.HexColor("#e2e8f1")),
    ("VALIGN",(0,0),(-1,-1),"TOP"), ("ALIGN",(3,0),(3,-1),"CENTER"),
    ("LEFTPADDING",(0,0),(-1,-1),4),("RIGHTPADDING",(0,0),(-1,-1),4),
    ("TOPPADDING",(0,0),(-1,-1),2.5),("BOTTOMPADDING",(0,0),(-1,-1),2.5),
]))
story.append(t); story.append(Spacer(1,3))
story.append(Paragraph("Eşleşmeler tam ad ve byte boyutu düzeyindedir. Baştaki “X / P / W / PDF” harfleri CTI listesindeki OCR artefaktıdır (bkz. 5.2).", st_small))

story.append(Paragraph("5.2  Önek (OCR) artefaktı", st_h2))
story.append(P(
    "CTI listesindeki baştaki harfler (ör. <b>X</b>ARAS, <b>P</b>Aras, <b>W</b>ARAS, <b>PDF</b>Aras) gerçek "
    "dosya adlarında yoktur. Bunlar, bir dizin görüntüsündeki <b>dosya türü ikonlarının</b> (Excel/Word/"
    "PDF/PowerPoint) OCR ile ada yapışmasıdır. Bu artefakt, listenin <b>gerçek bir dizin listesinden</b> "
    "üretildiğini, elle uydurulmadığını gösterir."))

story.append(Paragraph("5.3  Hassas veri kategorileri (ARAS KARGO alt ağacından örnekler)", st_h2))
sensitive = [
    ("Kimlik / parola", "ARAS KARGO ÇMA ŞİFRELER.xlsx; ARAS KARGO ŞİFRE HAZIRLIK.xlsx; 21.11.2014-Manuel Şifre ve Kitapçık Listesi.xlsx; Şifre Bilgileri Seher icin.xlsx"),
    ("Kişisel veri (iletişim)", "21.11.2014-Kişisel e-posta adresleri.xlsx; 26484-5-8 ARALIK BALTAŞ EKİP LİSTESİ.xls; açıkuçlusoru(kişisayıları).xlsx"),
    ("Çalışan anket sonuçları", "ANKET SONUÇLARI/** (il ve bölge bazlı yüzlerce .xls); ÇALIŞAN MEMNUNİYETİ / MUTLULUĞU / BAĞLILIĞI (.xlsx, .rar); ARAS KARGO ANKET LİSTE (TÜMÜ).xls"),
    ("Kurumsal sunum / strateji", "Aras_Kargo_SUNUM_2013_Üst Yönetim Sunumu_DBE.ppt / .rar; Aras Kargo Sunum 2014*.pptx; ARAS KARGO YETKİNLİKLER REHBERİ.doc"),
    ("Ham veri setleri (büyük)", "2012.xlsm (~91 MB); Aras yeni sonuclar.xlsx (~35 MB); Aras Kargo 2014 Sonuclar v3.xlsx"),
]
t = Table([[P(a, st_cellb), P(b, st_cell)] for a,b in sensitive], colWidths=[42*mm, 132*mm])
t.setStyle(TableStyle([
    ("ROWBACKGROUNDS",(0,0),(-1,-1),[colors.white, LIGHT]),
    ("BOX",(0,0),(-1,-1),0.4,LINE), ("INNERGRID",(0,0),(-1,-1),0.25,colors.HexColor("#e2e8f1")),
    ("VALIGN",(0,0),(-1,-1),"TOP"),
    ("LEFTPADDING",(0,0),(-1,-1),5),("RIGHTPADDING",(0,0),(-1,-1),5),
    ("TOPPADDING",(0,0),(-1,-1),3),("BOTTOMPADDING",(0,0),(-1,-1),3),
]))
story.append(t)

# ---------------- 6 ----------------
story.append(Paragraph("6. Doğrulama Sınırları", st_h1)); story.append(rule())
for b in [
    "<b>Doğrulanan:</b> ilgili dosyaların belirtilen ad ve boyutlarla sızıntı ağacında mevcut olduğu ve listenin gerçek bir dizinden türetildiği.",
    "<b>Doğrulanmayan:</b> yayımlanan içeriklerin orijinal/bozulmamış olduğu. Bunun için CTI’nin sağlayacağı hash (SHA-256) ile kurumdaki orijinallerin karşılaştırılması gerekir.",
    "Meta veri doğrulaması sızıntı iddiasını yüksek güvenle teyit eder; ancak tek tek dosya içeriklerinin bütünlüğünü kanıtlamaz.",
]:
    story.append(B(b))

# ---------------- 7 ----------------
story.append(Paragraph("7. Göstergeler (IOC)", st_h1)); story.append(rule())
ioc = [
    ["Tür", "Değer", "Not"],
    ["Ön yüz (host)", "satlabonline[.]surge[.]sh", "Ücretsiz/tek kullanımlık barındırma; tam alan adı engellenmeli, *.surge.sh engellenmemeli"],
    ["Dosya barındırma", "anonfilesnew[.]com", "Sızdırılan dökümanların harici depolama adresi"],
    ["Operatör markası", "“Solomon’s Shamir”", "Sızıntı sayfasının başlığı"],
]
data = [[P(c, st_cellb if i==0 else st_cell) for c in r] for i,r in enumerate(ioc)]
t = Table(data, colWidths=[26*mm, 50*mm, 98*mm], repeatRows=1)
t.setStyle(TableStyle([
    ("BACKGROUND",(0,0),(-1,0), NAVY),
    ("ROWBACKGROUNDS",(0,1),(-1,-1),[colors.white, LIGHT]),
    ("BOX",(0,0),(-1,-1),0.4,LINE), ("INNERGRID",(0,0),(-1,-1),0.25,colors.HexColor("#e2e8f1")),
    ("VALIGN",(0,0),(-1,-1),"TOP"),
    ("LEFTPADDING",(0,0),(-1,-1),4),("RIGHTPADDING",(0,0),(-1,-1),4),
    ("TOPPADDING",(0,0),(-1,-1),2.5),("BOTTOMPADDING",(0,0),(-1,-1),2.5),
]))
story.append(t)

# ---------------- 8 ----------------
story.append(Paragraph("8. Önerilen Aksiyonlar", st_h1)); story.append(rule())
recs = [
    ("Acil (0–24 saat)", "Olay müdahale ekibini devreye alın; CTI’den hash/örnek ve güven skoru isteyin. Şifre dosyalarındaki tüm hesapları sıfırlayın (MFA zorunlu, oturum/token iptali, log hunt). Sızıntı sayfasına kurumsal ağdan erişmeyin; örnek incelemesi gerekirse izole ortam + delil zinciri."),
    ("KVKK / hukuk (24–72 saat)", "Kişisel veri (e-posta listeleri, çalışan anketleri, ekip listeleri) sızmıştır. Veri sorumlusuysanız ihlali öğrenmeden itibaren kural olarak 72 saat içinde Kurul’a bildirin. İşleyen/danışman Baltaş Grubu ile koordinasyon ve sözleşmesel yükümlülükler değerlendirilmeli."),
    ("Doğrulama / teknik", "Orijinali kurumda bulunan dosyaların SHA-256’sını hesaplayıp CTI hash’i ile karşılaştırın. Kök nedeni ve erişim penceresini (paylaşım izinleri, uzak erişim, tedarikçi sistemleri) araştırın."),
    ("Tedarikçi / yaygın etki", "Ağaç 264 müşteri kurumu kapsar; yalnızca ARAS KARGO değil. İlgili tarafların bilgilendirilmesi ve tedarik zinciri risk yönetimi gündeme alınmalı."),
    ("İzleme ve iletişim", "Aynı aktörün ek yayın/gasp girişimini izleyin; saldırganla iletişim/ödeme yok; kriz iletişimi ve paydaş bilgilendirmesi hukuk onayıyla yürütülmeli."),
    ("Kalıcı iyileştirme", "DLP ve egress izleme, hassas veri envanteri/sınıflandırma, parola kasası + least privilege + MFA, tedarikçi/üçüncü taraf risk yönetimi."),
]
rec_rows = [[P(a, St("rh", fontName="UB", textColor=NAVY, fontSize=9.6)), P(b, st_cell)] for a,b in recs]
t = Table(rec_rows, colWidths=[40*mm, 134*mm])
t.setStyle(TableStyle([
    ("ROWBACKGROUNDS",(0,0),(-1,-1),[colors.white, LIGHT]),
    ("BOX",(0,0),(-1,-1),0.4,LINE), ("INNERGRID",(0,0),(-1,-1),0.25,colors.HexColor("#e2e8f1")),
    ("VALIGN",(0,0),(-1,-1),"TOP"),
    ("LEFTPADDING",(0,0),(-1,-1),5),("RIGHTPADDING",(0,0),(-1,-1),5),
    ("TOPPADDING",(0,0),(-1,-1),3.5),("BOTTOMPADDING",(0,0),(-1,-1),3.5),
]))
story.append(t)

# ---------------- Ek ----------------
story.append(Spacer(1,4)); story.append(rule(color=LINE, th=0.5, sb=2, sa=5))
story.append(Paragraph("Ek — Metodoloji Notu", st_h2))
story.append(P(
    "Tüm bulgular kamuya açık sızıntı sayfasının yayımladığı meta veriye dayanır; hiçbir döküman "
    "indirilmemiş veya çalıştırılmamıştır. Bu rapor, olay müdahalesi ve bildirim süreçlerine girdi olmak "
    "üzere hazırlanmıştır ve hukuki görüş yerine geçmez. Sınıflandırma: TLP:AMBER.", st_small))

def footer(canv, doc):
    canv.saveState()
    canv.setFont("U", 7.5); canv.setFillColor(GREY)
    canv.drawString(18*mm, 12*mm, "TLP:AMBER — Kurum İçi — Veri Sızıntısı Doğrulama Raporu")
    canv.drawRightString(A4[0]-18*mm, 12*mm, "Sayfa %d" % canv.getPageNumber())
    canv.setStrokeColor(LINE); canv.line(18*mm, 15*mm, A4[0]-18*mm, 15*mm)
    canv.restoreState()

doc = SimpleDocTemplate(OUT, pagesize=A4, leftMargin=18*mm, rightMargin=18*mm,
                        topMargin=15*mm, bottomMargin=19*mm,
                        title="Veri Sızıntısı Doğrulama Raporu — Baltaş Grubu / ARAS KARGO",
                        author="CTI / IR")
doc.build(story, onFirstPage=footer, onLaterPages=footer)
print("WROTE:", OUT)
