const express = require("express");
const puppeteer = require("puppeteer");
const AdmZip = require("adm-zip");
const axios = require("axios");
const path = require("path");
const { translate } = require("@vitalets/google-translate-api"); // 💡 번역 라이브러리 로드
const app = express();

app.use(express.json());
app.use(express.static(path.join(__dirname)));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.post("/api/extract", async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: "URL이 필요합니다." });

  let browser;
  try {
    browser = await puppeteer.launch({
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || null,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
      ],
    });

    const page = await browser.newPage();
    // 💡 일본 원본 페이지를 긁기 위해 언어 설정을 일본어로 명시
    await page.setExtraHTTPHeaders({ "Accept-Language": "ja-JP,ja;q=0.9" });
    await page.goto(url, { waitUntil: "networkidle2", timeout: 60000 });

    // 💡 1kuji 원본 일본어 사이트의 실제 구조인 h2 태그 내부 텍스트 추출
    const rawTitle = await page.evaluate(() => {
      const h2Element = document.querySelector(".aboutColInner h2");
      return h2Element ? h2Element.innerText.trim() : "";
    });

    // 폴백용 주소창 코드 명칭 추출
    const urlParts = url.split("/").filter((p) => p.length > 0);
    const fallbackName =
      urlParts.length > 0 ? urlParts[urlParts.length - 1] : "ichibankuji";

    let finalTitle = fallbackName;

    // 💡 일본어 제목을 정상적으로 가져왔다면 한국어로 자동 번역 진행!
    if (rawTitle) {
      try {
        const translation = await translate(rawTitle, { to: "ko" });
        finalTitle = translation.text;
        console.log(`[번역 완료] 원문: ${rawTitle} -> 한글: ${finalTitle}`);
      } catch (transErr) {
        console.error("번역 실패, 원문 일본어로 대체합니다:", transErr);
        finalTitle = rawTitle; // 번역 실패 시 일본어 원문 그대로 사용
      }
    }

    // 이미지 태그 크롤링 (products 폴더에 들어있는 알맹이 이미지들만 저격)
    const imageUrls = await page.evaluate(() => {
      return Array.from(document.querySelectorAll("img"))
        .map((img) => img.src)
        .filter((src) => src.includes("/products/"));
    });

    // 💡 이미지가 없다는 건 주소가 잘못되었거나 없는 번호라는 뜻!
    if (imageUrls.length === 0) {
      return res
        .status(404)
        .json({
          error:
            "추출할 수 있는 이미지가 없거나 존재하지 않는 상품 번호입니다.",
        });
    }

    const zip = new AdmZip();

    for (let i = 0; i < imageUrls.length; i++) {
      try {
        const imgResponse = await axios.get(imageUrls[i], {
          responseType: "arraybuffer",
        });
        zip.addFile(`image_${i + 1}.jpg`, Buffer.from(imgResponse.data));
      } catch (e) {
        console.error("이미지 다운로드 실패:", imageUrls[i]);
      }
    }

    const zipBuffer = zip.toBuffer();

    // 헤더에 번역된 한글 타이틀 안전하게 인코딩해서 주입
    res.set({
      "Content-Type": "application/zip",
      "Content-Length": zipBuffer.length,
      "Access-Control-Expose-Headers": "X-Kuji-Title",
      "X-Kuji-Title": encodeURIComponent(finalTitle),
    });

    return res.send(zipBuffer);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: error.message });
  } finally {
    if (browser) await browser.close();
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`서버가 포트 ${PORT}에서 작동 중입니다.`);
});
