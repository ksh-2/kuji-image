const express = require("express");
const puppeteer = require("puppeteer");
const AdmZip = require("adm-zip");
const axios = require("axios");
const path = require("path"); // 💡 경로 처리를 위해 추가
const app = express();

app.use(express.json());

// 💡 [핵심 추가] 루트 폴더에 있는 index.html 및 정적 파일들을 브라우저에 서빙합니다.
app.use(express.static(path.join(__dirname)));

// CORS 설정이 필요한 경우 아래 주석을 해제하세요.
/*
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept, X-Kuji-Title");
  res.header("Access-Control-Expose-Headers", "X-Kuji-Title");
  next();
});
*/

// 💡 [핵심 추가] 사용자가 그냥 주소만 치고 들어왔을 때 index.html을 보여줍니다.
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

//  crawling API 엔드포인트
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
    await page.goto(url, { waitUntil: "networkidle2", timeout: 60000 });

    // 1kuji 페이지에서 타이틀(h2 태그 내부 text) 추출
    const title = await page.evaluate(() => {
      const h2Element = document.querySelector(".aboutColInner h2");
      return h2Element ? h2Element.innerText.trim() : "";
    });

    const urlParts = url.split("/").filter((p) => p.length > 0);
    const fallbackName =
      urlParts.length > 0 ? urlParts[urlParts.length - 1] : "ichibankuji";

    const finalTitle = title || fallbackName;

    // 이미지 태그 크롤링 (products가 포함된 이미지 주소 추출)
    const imageUrls = await page.evaluate(() => {
      return Array.from(document.querySelectorAll("img"))
        .map((img) => img.src)
        .filter((src) => src.includes("products"));
    });

    if (imageUrls.length === 0) {
      return res
        .status(404)
        .json({ error: "추출할 수 있는 이미지가 없습니다." });
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

    // 프론트엔드가 한글 타이틀을 읽을 수 있도록 헤더 주입
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
