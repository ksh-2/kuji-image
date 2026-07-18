const express = require("express");
const puppeteer = require("puppeteer");
const AdmZip = require("adm-zip");
const axios = require("axios");
const path = require("path");
const { translate } = require("@vitalets/google-translate-api");
const app = express();

app.use(express.json());
app.use(express.static(path.join(__dirname)));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.post("/api/extract", async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: "URL이 필요합니다." });

  // 💡 URL에서 고유 상품 코드 추출 (예: https://1kuji.com/products/kimetsu28 -> kimetsu28)
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
      try {
        const translation = await translate(rawTitle, { to: "ko" });
        // 💡 [핵심 수정] 번역된 한글 제목 뒤에 고유 코드(예: kimetsu28)를 결합합니다.
        finalTitle = `${translation.text}(${kujiCode})`;
        console.log(`[번역 및 코드 추가] -> ${finalTitle}`);
      } catch (transErr) {
        console.error("번역 실패, 일본어 제목 + 코드로 대체:", transErr);
        finalTitle = `${rawTitle}(${kujiCode})`;
      }
    } else {
      // 제목 크롤링 자체를 실패했을 때의 폴백 처리
      finalTitle = kujiCode;
    }

    // 본문 영역 내부의 이미지 에셋 타겟팅 수집
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
