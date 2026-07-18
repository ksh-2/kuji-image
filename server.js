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
    // 일본 원본 데이터 확보를 위해 헤더 고정
    await page.setExtraHTTPHeaders({ "Accept-Language": "ja-JP,ja;q=0.9" });
    await page.goto(url, { waitUntil: "networkidle2", timeout: 60000 });

    // 1kuji 일본어 원본 타이틀 획득
    const rawTitle = await page.evaluate(() => {
      const h2Element = document.querySelector(".aboutColInner h2");
      return h2Element ? h2Element.innerText.trim() : "";
    });

    const urlParts = url.split("/").filter((p) => p.length > 0);
    const fallbackName =
      urlParts.length > 0 ? urlParts[urlParts.length - 1] : "ichibankuji";

    let finalTitle = fallbackName;

    if (rawTitle) {
      try {
        const translation = await translate(rawTitle, { to: "ko" });
        finalTitle = translation.text;
        console.log(`[번역 성공] 원문: ${rawTitle} -> 한글: ${finalTitle}`);
      } catch (transErr) {
        console.error("번역 실패, 일본어 대체:", transErr);
        finalTitle = rawTitle;
      }
    }

    // 💡 [핵심 수정] 주소에 'products' 문자열 매칭 대신, 메인 본문(.mainCol) 영역 안에 있는 진짜 상품 이미지들을 타겟팅합니다.
    const imageUrls = await page.evaluate(() => {
      // 본문 영역 또는 갤러리 영역의 이미지 태그들을 수집
      const contentImages = Array.from(
        document.querySelectorAll(
          ".mainCol img, #galleryCol img, .aboutColInner img",
        ),
      );

      return contentImages
        .map((img) => img.src)
        .filter((src) => {
          if (!src) return false;
          // 로고, 아이콘, 탑 버튼, 페이스북/트위터 공유 버튼 이미지 등 불필요한 에셋은 전부 제외
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

    // 중복 제거 (동일한 이미지 주소가 여러 개 파싱되는 것 방지)
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
        // 파일 확장자 추출 (.jpg, .png 등) 및 폴백 처리
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
