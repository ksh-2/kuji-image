const express = require("express");
const puppeteer = require("puppeteer");
const AdmZip = require("adm-zip");
const axios = require("axios");
const app = express();

app.use(express.json());
// CORS 설정이 있다면 그대로 유지

app.post("/api/extract", async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: "URL이 필요합니다." });

  let browser;
  try {
    // Puppeteer 크롬 브라우저 실행 (Nixpacks 환경 설정 준수)
    browser = await puppeteer.launch({
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || null,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
      ],
    });

    const page = await browser.newPage();
    await page.goto(url, { waitUntil: "networkidle2", timeout: 60000 });

    // 💡 [핵심 추가] 1kuji 페이지에서 타이틀(h2 태그 내부 text) 추출하기
    // 제공해주신 DOM 구조에 맞추어 타이틀을 가져옵니다.
    const title = await page.evaluate(() => {
      const h2Element = document.querySelector(".aboutColInner h2");
      return h2Element ? h2Element.innerText.trim() : "";
    });

    // 💡 테스트용 혹은 백업 파일명을 위해 주소창 번호도 추출
    const urlParts = url.split("/").filter((p) => p.length > 0);
    const fallbackName =
      urlParts.length > 0 ? urlParts[urlParts.length - 1] : "ichibankuji";

    // 만약 타이틀을 못 가져왔다면 fallback 이름 사용
    const finalTitle = title || fallbackName;

    // (기존 이미지 태그 크롤링 및 adm-zip 압축 로직이 아래에 위치합니다)
    // 예시 구조:
    const imageUrls = await page.evaluate(() => {
      // 이미지 주소들을 수집하는 기존 소스코드를 그대로 유지해주세요.
      // 예: return Array.from(document.querySelectorAll('.mainCol img')).map(img => img.src);
      return Array.from(document.querySelectorAll("img"))
        .map((img) => img.src)
        .filter((src) => src.includes("products"));
    });

    const zip = new AdmZip();

    // 이미지 다운로드 및 ZIP 파일 추가 로직 (기존 로직 유지)
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

    // 💡 [중요] 프론트엔드가 한글 타이틀을 안전하게 읽을 수 있도록 헤더에 인코딩하여 주입합니다.
    res.set({
      "Content-Type": "application/zip",
      "Content-Length": zipBuffer.length,
      "Access-Control-Expose-Headers": "X-Kuji-Title", // 브라우저가 이 헤더를 읽을 수 있도록 허용
      "X-Kuji-Title": encodeURIComponent(finalTitle), // 한글 깨짐 방지를 위해 인코딩
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
