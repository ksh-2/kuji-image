const express = require("express");
const puppeteer = require("puppeteer");
const AdmZip = require("adm-zip");
const axios = require("axios");
const path = require("path");
const { translate } = require("@vitalets/google-translate-api");
const app = express();

app.use(express.json());
app.use(express.static(path.join(__dirname)));

// 💡 헬퍼 함수: 번역 실패 시 재시도를 위한 딜레이 함수
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 💡 안전한 번역 수행 함수 (실패 시 1회 재시도 로직 내장)
async function safeTranslate(text) {
  try {
    const res = await translate(text, { to: "ko" });
    return res.text;
  } catch (err) {
    console.warn(
      "첫 번째 번역 시도 실패, 1.5초 후 재시도합니다...",
      err.message,
    );
    await wait(1500);
    try {
      const resRetry = await translate(text, { to: "ko" });
      return resRetry.text;
    } catch (retryErr) {
      console.error("두 번째 번역 시도도 실패했습니다.", retryErr.message);
      return null; // 완전히 실패 시 null 반환
    }
  }
}

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.post("/api/extract", async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: "URL이 필요합니다." });

  const urlParts = url.split("/").filter((p) => p.length > 0);
  const kujiCode =
    urlParts.length > 0 ? urlParts[urlParts.length - 1] : "ichibankuji";

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
    await page.setExtraHTTPHeaders({ "Accept-Language": "ja-JP,ja;q=0.9" });
    await page.goto(url, { waitUntil: "networkidle2", timeout: 60000 });

    // 1kuji 일본어 원본 타이틀 획득
    const rawTitle = await page.evaluate(() => {
      const h2Element = document.querySelector(".aboutColInner h2");
      return h2Element ? h2Element.innerText.trim() : "";
    });

    let finalTitle = "";

    if (rawTitle) {
      // 💡 한결 강인해진 번역 함수 호출
      const translatedText = await safeTranslate(rawTitle);

      if (translatedText) {
        finalTitle = `${translatedText}(${kujiCode})`;
      } else {
        // 번역 API가 완벽하게 차단되었을 때: 일본어 원문 활용
        finalTitle = `${rawTitle}(${kujiCode})`;
      }
    } else {
      // 제목 태그를 못 긁었을 때 기본적인 명칭 조립 규칙 고정 (가독성 향상)
      // 영어 소문자로 깨지는 걸 방지하기 위해 앞글자를 대문자로 정제
      const cleanCode = kujiCode.charAt(0).toUpperCase() + kujiCode.slice(1);
      finalTitle = `제일복권_${cleanCode}(${kujiCode})`;
    }

    // 본문 영역 내부의 상품 이미지 에셋 정밀 수집
    const imageUrls = await page.evaluate(() => {
      const contentImages = Array.from(
        document.querySelectorAll(
          ".mainCol img, #galleryCol img, .aboutColInner img",
        ),
      );
      return contentImages
        .map((img) => img.src)
        .filter((src) => {
          if (!src) return false;
          const isNoise =
            src.includes("logo") ||
            src.includes("icon") ||
            src.includes("btn_") ||
            src.includes("share") ||
            src.includes("tw.png") ||
            src.includes("fb.png") ||
            src.includes("line.png");
          return !isNoise;
        });
    });

    const uniqueImageUrls = [...new Set(imageUrls)];

    if (uniqueImageUrls.length === 0) {
      return res
        .status(404)
        .json({
          error:
            "추출할 수 있는 상품 이미지가 해당 페이지에 존재하지 않습니다.",
        });
    }

    const zip = new AdmZip();

    for (let i = 0; i < uniqueImageUrls.length; i++) {
      try {
        const imgResponse = await axios.get(uniqueImageUrls[i], {
          responseType: "arraybuffer",
        });
        let ext = ".jpg";
        if (uniqueImageUrls[i].toLowerCase().includes(".png")) ext = ".png";
        if (uniqueImageUrls[i].toLowerCase().includes(".webp")) ext = ".webp";

        zip.addFile(`image_${i + 1}${ext}`, Buffer.from(imgResponse.data));
      } catch (e) {
        console.error("이미지 다운로드 실패:", uniqueImageUrls[i]);
      }
    }

    const zipBuffer = zip.toBuffer();

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
