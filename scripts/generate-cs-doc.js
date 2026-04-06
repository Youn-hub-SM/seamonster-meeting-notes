const { Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
        HeadingLevel, AlignmentType, BorderStyle, WidthType, ShadingType,
        PageBreak } = require('docx');
const fs = require('fs');

const border = { style: BorderStyle.SINGLE, size: 1, color: "CCCCCC" };
const borders = { top: border, bottom: border, left: border, right: border };
const cellMargins = { top: 80, bottom: 80, left: 120, right: 120 };

function hCell(text, w) {
  return new TableCell({ borders, width: { size: w, type: WidthType.DXA },
    shading: { fill: "F15A30", type: ShadingType.CLEAR }, margins: cellMargins,
    children: [new Paragraph({ children: [new TextRun({ text, bold: true, color: "FFFFFF", font: "Arial", size: 20 })] })] });
}
function tCell(text, w) {
  return new TableCell({ borders, width: { size: w, type: WidthType.DXA }, margins: cellMargins,
    children: [new Paragraph({ children: [new TextRun({ text, font: "Arial", size: 20 })] })] });
}
function h1(t) { return new Paragraph({ heading: HeadingLevel.HEADING_1, spacing: { before: 360, after: 200 }, children: [new TextRun({ text: t, bold: true, font: "Arial", size: 32, color: "F15A30" })] }); }
function h2(t) { return new Paragraph({ heading: HeadingLevel.HEADING_2, spacing: { before: 280, after: 160 }, children: [new TextRun({ text: t, bold: true, font: "Arial", size: 26 })] }); }
function h3(t) { return new Paragraph({ heading: HeadingLevel.HEADING_3, spacing: { before: 200, after: 120 }, children: [new TextRun({ text: t, bold: true, font: "Arial", size: 22 })] }); }
function p(t) { return new Paragraph({ spacing: { after: 120 }, children: [new TextRun({ text: t, font: "Arial", size: 20 })] }); }
function bp(label, text) { return new Paragraph({ spacing: { after: 120 }, children: [ new TextRun({ text: label, bold: true, font: "Arial", size: 20 }), new TextRun({ text, font: "Arial", size: 20 }) ] }); }
function warn(t) { return new Paragraph({ spacing: { after: 120 }, children: [new TextRun({ text: t, font: "Arial", size: 20, color: "CC0000", bold: true })] }); }
function quote(t) { return new Paragraph({ spacing: { after: 120 }, indent: { left: 400 }, children: [new TextRun({ text: t, font: "Arial", size: 20, italics: true, color: "555555" })] }); }

const doc = new Document({
  sections: [{
    properties: { page: { size: { width: 12240, height: 15840 }, margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 } } },
    children: [
      // 표지
      new Paragraph({ spacing: { before: 3000 }, alignment: AlignmentType.CENTER, children: [new TextRun({ text: "\uC528\uBAac\uC2A4\uD130 CS \uB2F5\uBCC0 \uC0DD\uC131\uAE30", font: "Arial", size: 48, bold: true, color: "F15A30" })] }),
      new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 200 }, children: [new TextRun({ text: "\uAE30\uBCF8 \uC9C0\uC2DD \uBB38\uC11C (v2.0)", font: "Arial", size: 24, color: "666666" })] }),
      new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: "2026\uB144 4\uC6D4 \uC791\uC131", font: "Arial", size: 20, color: "999999" })] }),
      new Paragraph({ children: [new PageBreak()] }),

      // ===== 1. 기본 응대 원칙 =====
      h1("1. \uAE30\uBCF8 \uC751\uB300 \uC6D0\uCE59 \uBC0F \uD1A4\uC559\uB9E4\uB108"),

      h2("1-1. \uACE0\uAC1D \uC751\uB300 4\uB2E8\uACC4 (\uC21C\uC11C \uACE0\uC815)"),
      p("\uBAA8\uB4E0 \uC751\uB300\uB294 \uBC18\uB4DC\uC2DC \uC544\uB798 \uC21C\uC11C\uB85C \uC9C4\uD589\uD569\uB2C8\uB2E4:"),
      bp("1\uB2E8\uACC4 - \uACF5\uAC10: ", "\uACE0\uAC1D\uC758 \uAC10\uC815\uACFC \uC0C1\uD669\uC5D0 \uBA3C\uC800 \uACF5\uAC10\uD569\uB2C8\uB2E4."),
      bp("2\uB2E8\uACC4 - \uD574\uACB0\uCC45 \uC6B0\uC120: ", "\uC6D0\uC778\uC774\uB098 \uD574\uBA85\uBCF4\uB2E4 \uD574\uACB0\uCC45\uC744 \uBA3C\uC800 \uC81C\uC2DC\uD569\uB2C8\uB2E4."),
      bp("3\uB2E8\uACC4 - \uC815\uBCF4 \uC911\uC2EC: ", "\uD574\uACB0\uCC45 \uC218\uC6A9 \uD6C4 \uAC10\uC815\uC744 \uCD5C\uC18C\uD654\uD558\uACE0 \uC815\uBCF4 \uC911\uC2EC\uC73C\uB85C \uC548\uB0B4\uD569\uB2C8\uB2E4."),
      bp("4\uB2E8\uACC4 - \uB2E4\uC74C \uD589\uB3D9: ", "\uC0AC\uC2E4\uACFC \uADFC\uAC70\uB97C \uBC14\uD0D5\uC73C\uB85C \uB2E4\uC74C \uD589\uB3D9\uC744 \uC548\uB0B4\uD569\uB2C8\uB2E4."),

      h2("1-2. \uD575\uC2EC \uBAA9\uD45C"),
      p("\uBAA8\uB4E0 \uBB38\uC81C\uB294 \uC528\uBAac\uC2A4\uD130\uC758 \uCC45\uC784\uC73C\uB85C \uAC04\uC8FC\uD569\uB2C8\uB2E4."),
      p("\uD2B9\uC815 \uC791\uC5C5\uC790\uC758 \uC798\uBABB\uC774\uB77C\uB294 \uB274\uC559\uC2A4\uB97C \uD53C\uD569\uB2C8\uB2E4."),
      warn("\uACE0\uAC1D\uC774 \"\uC774 \uC0C1\uB2F4\uC6D0\uC740 \uB0B4 \uD3B8\uC774\uB2E4\"\uB77C\uACE0 \uB290\uAEF4\uC57C \uD569\uB2C8\uB2E4."),

      h2("1-3. \uD1A4\uC559\uB9E4\uB108"),
      p("\uB2E8\uC815\uD558\uACE0 \uCC28\uBD84\uD558\uBA70 \uCC45\uC784\uAC10 \uC788\uB294 \uD0DC\uB3C4\uB97C \uC720\uC9C0\uD569\uB2C8\uB2E4."),
      p("\uC0AC\uACFC \uB0A8\uBC1C, \uACFC\uC789 \uCE5C\uC808, \uC7A5\uD669\uD55C \uAC10\uC815\uC801 \uC124\uB4DD\uC740 \uD53C\uD569\uB2C8\uB2E4."),

      h2("1-4. \uD544\uC218 \uD3EC\uD568 \uD45C\uD604"),
      bp("\uC0C1\uD0DC \uC778\uC9C0: ", "\uD604\uC7AC \uC0C1\uD669\uC744 \uC778\uC9C0\uD558\uACE0 \uC788\uB2E4\uB294 \uD45C\uD604"),
      bp("\uB2E4\uC74C \uD589\uB3D9: ", "\uC55E\uC73C\uB85C \uC5B4\uB5BB\uAC8C \uC9C4\uD589\uB420 \uAC83\uC778\uC9C0 \uC548\uB0B4"),

      h2("1-5. \uAE08\uC9C0 \uC0AC\uD56D"),
      warn("\uACE0\uAC1D\uC5D0\uAC8C \uCC45\uC784 \uCD94\uAD81 \uAE08\uC9C0"),
      warn("\"\uC6D0\uB798 \uADF8\uB807\uB2E4\", \"\uD0DD\uBC30\uC0AC \uBB38\uC81C\uB2E4\" \uC2DD\uC758 \uCC45\uC784 \uD68C\uD53C \uAE08\uC9C0"),
      warn("\uBCF4\uC0C1 \uAE30\uC900\uC744 \uD750\uB9AC\uB294 \uB9D0 \uAE08\uC9C0"),

      new Paragraph({ children: [new PageBreak()] }),

      // ===== 2. 클레임 및 배송 문제 =====
      h1("2. \uD074\uB808\uC784 \uBC0F \uBC30\uC1A1 \uBB38\uC81C \uD574\uACB0 \uB9E4\uB274\uC5BC"),

      h2("2-1. \uBC30\uC1A1 \uC9C0\uC5F0"),
      p("\uC0AC\uACFC \uD6C4 \uD604\uC7AC \uBC30\uC1A1 \uC0C1\uD0DC\uB97C \uC548\uB0B4\uD558\uACE0, \uC989\uC2DC \uC870\uCE58 \uB0B4\uC6A9\uACFC \uB2E4\uC74C \uC548\uB0B4 \uC2DC\uC810\uC744 \uBA85\uD655\uD788 \uC804\uB2EC\uD569\uB2C8\uB2E4."),
      quote("\"\uACE0\uAC1D\uB2D8, \uBC30\uC1A1\uC774 \uC9C0\uC5F0\uB418\uC5B4 \uBD88\uD3B8\uC744 \uB4DC\uB824 \uC815\uB9D0 \uC8C4\uC1A1\uD569\uB2C8\uB2E4. \uD604\uC7AC \uBC30\uC1A1 \uC0C1\uD669\uC744 \uD655\uC778\uD558\uACE0 \uC788\uC73C\uBA70, \uD655\uC778\uB418\uB294 \uB300\uB85C \uBC14\uB85C \uC548\uB0B4\uB4DC\uB9AC\uACA0\uC2B5\uB2C8\uB2E4.\""),

      h2("2-2. \uAC00\uC2DC \uBC0F \uD68C\uCDA9 \uBC1C\uACAC (\uC77C\uBC18 \uC81C\uD488)"),
      bp("\uC548\uC804 \uD655\uC778: ", "\"\uB2E4\uCE58\uC9C0\uB294 \uC54A\uC73C\uC168\uC744\uAE4C\uC694?\"\uB85C \uACE0\uAC1D \uC548\uC804 \uBA3C\uC800 \uD655\uC778"),
      bp("\uAC00\uC2DC \uC124\uBA85: ", "\uC218\uC791\uC5C5 \uACFC\uC815\uC0C1 \uB4DC\uBB3C\uAC8C \uAC00\uC2DC\uAC00 \uB0A8\uC744 \uC218 \uC788\uC74C"),
      bp("\uD68C\uCDA9 \uC124\uBA85: ", "\uAC00\uC5F4 \uC2DC \uC0AC\uBA78\uB418\uC5B4 \uC778\uCCB4\uC5D0 \uBB34\uD574\uD568"),
      bp("\uBCF4\uC0C1: ", "5,000\uC6D0 \uC801\uB9BD\uAE08 \uC548\uB0B4, \uD655\uC778 \uC2DC \uC989\uC2DC \uCC98\uB9AC"),

      h2("2-3. \uC774\uBB3C\uC9C8 \uBC1C\uACAC"),
      p("\uB2E4\uCE58\uC9C0 \uC54A\uC558\uB294\uC9C0 \uD655\uC778 \uD6C4, \uC815\uD655\uD55C \uD30C\uC545\uC744 \uC704\uD574 \uC81C\uD488 \uC0AC\uC9C4\uC744 \uC694\uCCAD\uD558\uACE0 \uBC14\uB85C \uC548\uB0B4\uD574 \uB4DC\uB9B4 \uAC83\uC744 \uC548\uB0B4\uD569\uB2C8\uB2E4."),

      h2("2-4. \uC9C4\uACF5 \uD480\uB9BC / \uB204\uB77D / \uC624\uBC30\uC1A1"),
      p("\uBD88\uD3B8\uD568\uC5D0 \uB300\uD574 \uC0AC\uACFC \uD6C4, \uC81C\uD488 \uC0AC\uC9C4\uC744 \uBCF4\uB0B4\uC8FC\uC2DC\uBA74 \uD658\uBD88 \uB610\uB294 \uC7AC\uBC1C\uC1A1 \uCC98\uB9AC\uB97C \uC548\uB0B4\uD569\uB2C8\uB2E4."),

      h2("2-5. \uC81C\uD488 \uB179\uC74C (\uD574\uB3D9)"),
      bp("1. ", "\uC81C\uD488 \uD655\uC778 \uC2DC\uAC01\uC744 \uBB3B\uC2B5\uB2C8\uB2E4."),
      bp("2. ", "\uBCF4\uC0C1 \uCC98\uB9AC\uB97C \uC704\uD574 \uC81C\uD488 \uBC0F \uBCF4\uB0C9 \uC0C1\uD0DC \uC804\uCCB4 \uC0AC\uC9C4\uC744 \uC694\uCCAD\uD569\uB2C8\uB2E4."),
      bp("3. ", "\uC2A4\uD2F0\uB85C\uD3FC \uBC15\uC2A4\uC640 \uC81C\uD488\uC758 \uD68C\uC218\uAC00 \uD544\uC694\uD558\uBBC0\uB85C \uBCF4\uAD00\uC744 \uB2F9\uBD80\uD569\uB2C8\uB2E4."),

      h2("2-6. \uCDE8\uC18C/\uD658\uBD88/\uAD50\uD658 (\uD3EC\uC7A5 \uC911)"),
      p("\uBD88\uB9AC\uD55C \uC870\uAC74\uBCF4\uB2E4 \uAC00\uB2A5 \uC5EC\uBD80 \uD655\uC778\uC744 \uBA3C\uC800 \uC81C\uC2DC\uD569\uB2C8\uB2E4."),
      p("\uC774\uBBF8 \uD0DD\uBC30\uC0AC\uB85C \uB118\uC5B4\uAC04 \uACBD\uC6B0\uC5D0\uB294 \uBD88\uAC00\uD568\uC744 \uB2E8\uC815\uD558\uAC8C \uC548\uB0B4\uD569\uB2C8\uB2E4."),

      new Paragraph({ children: [new PageBreak()] }),

      // ===== 3. 일반 제품 FAQ =====
      h1("3. \uC77C\uBC18 \uC81C\uD488 FAQ \uD45C\uC900 \uB2F5\uBCC0"),

      h3("Q: \uC81C\uD488\uC5D0 \uC18C\uAE08\uC774 \uB4E4\uC5B4\uAC00 \uC788\uB098\uC694?"),
      p("A: \uC804\uC790\uB80C\uC9C0\uC6A9 \uC81C\uD488(\uC18C\uAE08/\uD6C4\uCD94 \uAC00\uBBF8\uB41C \uC800\uC5FC)\uC744 \uC81C\uC678\uD55C \uBAA8\uB4E0 \uC81C\uD488\uC740 \uC77C\uBC18 \uC0BC\uCE58\uB97C \uD3EC\uD568\uD574 \uBB34\uC5FC\uC785\uB2C8\uB2E4."),

      h3("Q: \uBCF4\uAD00 \uBC0F \uD574\uB3D9\uC740 \uC5B4\uB5BB\uAC8C \uD558\uB098\uC694?"),
      p("A: \uB0C9\uB3D9(-18\u2103) \uC0C1\uD0DC\uB85C \uC18C\uBE44\uAE30\uD55C\uAE4C\uC9C0 \uBCF4\uAD00 \uAC00\uB2A5\uD569\uB2C8\uB2E4."),
      p("\uD574\uB3D9 \uC2DC\uC5D0\uB294 \uB0C9\uC7A5 \uD574\uB3D9 \uD6C4 1~2\uC77C \uC774\uB0B4 \uC12D\uCDE8\uB97C \uAD8C\uC7A5\uD569\uB2C8\uB2E4."),
      p("\uC7A5\uC2DC\uAC04 \uC0C1\uC628 \uD574\uB3D9\uC740 \uD53C\uD574\uC8FC\uC138\uC694."),
      p("\uAE09\uD560 \uB54C\uB294 \uB0C9\uB3D9 \uC0C1\uD0DC\uB85C \uBC14\uB85C \uC870\uB9AC\uD558\uB418 \uC870\uB9AC \uC2DC\uAC04\uC744 \uB298\uB824\uC8FC\uC138\uC694."),

      h3("Q: \uC544\uC774\uAC00 \uBA39\uC5B4\uB3C4 \uB418\uB098\uC694?"),
      p("A: \uB80C\uC9C0\uC6A9 \uC81C\uD488\uC744 \uC81C\uC678\uD558\uBA74 \uB300\uBD80\uBD84 \uBB34\uC5FC\uC774\uB77C \uC544\uC774\uB3C4 \uC12D\uCDE8 \uAC00\uB2A5\uD569\uB2C8\uB2E4."),
      warn("\uB2E8, \uC794\uAC00\uC2DC\uAC00 \uB098\uC62C \uC218 \uC788\uC5B4 \uC12D\uCDE8 \uC804 \uD655\uC778\uC744 \uB2F9\uBD80\uD569\uB2C8\uB2E4."),

      h3("Q: \uC6D0\uC0B0\uC9C0\uAC00 \uC5B4\uB514\uC778\uAC00\uC694?"),
      p("A: \uC5F0\uC5B4(\uCE60\uB808), \uD2F8\uB77C\uD53C\uC544(\uB300\uB9CC), \uC624\uC9D5\uC5B4(\uBCA0\uD2B8\uB0A8)\uC744 \uC81C\uC678\uD55C \uC804 \uC81C\uD488\uC740 \uAD6D\uB0B4\uC0B0\uC785\uB2C8\uB2E4."),

      h3("Q: \uBC29\uC0AC\uB2A5 \uAC80\uC0AC\uB97C \uD558\uB098\uC694?"),
      p("A: \uC81C\uC870\uC0AC\uC778 '\uD30C\uB3C4\uC18C\uB9AC'\uC5D0\uC11C \uAD50\uC721\uCCAD \uC8FC\uAD00 \uBC29\uC0AC\uB2A5 \uAC80\uC0AC\uB97C \uC5F0 2\uD68C \uC2E4\uC2DC\uD558\uACE0 \uC788\uC2B5\uB2C8\uB2E4."),

      h3("Q: \uC0DD\uC120 \uCD94\uCC9C\uD574 \uC8FC\uC138\uC694"),
      p("A: \uB2E4\uC74C 3\uAC00\uC9C0\uB97C \uC54C\uB824\uC8FC\uC2DC\uBA74 \uB9DE\uCDA4 \uCD94\uCC9C\uD574 \uB4DC\uB9BD\uB2C8\uB2E4:"),
      bp("1) ", "\uB4DC\uC2DC\uB294 \uBD84 (\uC131\uC778/\uC544\uC774 \uB4F1)"),
      bp("2) ", "\uBAA9\uC801 (\uB2E8\uBC31\uC9C8 \uC2DD\uB2E8/\uC774\uC720\uC2DD \uB4F1)"),
      bp("3) ", "\uC870\uB9AC \uBC29\uC2DD (\uD504\uB77C\uC774\uD32C/\uC804\uC790\uB80C\uC9C0 \uB4F1)"),

      new Paragraph({ children: [new PageBreak()] }),

      // ===== 4. 이유식 전용 매뉴얼 =====
      h1("4. \uC774\uC720\uC2DD \uC804\uC6A9 \uC0DD\uC120 \uD2B9\uBCC4 \uB9E4\uB274\uC5BC"),

      h2("4-1. \uC774\uC720\uC2DD \uC81C\uD488 \uD2B9\uC9D5 (\uB300\uAD6C\uC0B4/\uB2EC\uACE0\uAE30\uC0B4)"),
      p("\uC77C\uBC18 \uC81C\uD488\uACFC \uB2E4\uB978 \uC810:"),
      bp("\uB4F1\uC0B4\uB9CC \uC0AC\uC6A9: ", "\uC794\uAC00\uC2DC\uAC00 \uAC70\uC758 \uC5C6\uC2B5\uB2C8\uB2E4."),
      bp("\uC0DD\uBB3C \uC6D0\uB8CC: ", "\uD55C \uBC88\uB3C4 \uC5BC\uB9AC\uC9C0 \uC54A\uC740 \uC0DD\uBB3C \uC6D0\uB8CC\uB97C \uC0AC\uC6A9\uD574 \uBD80\uB4DC\uB7FD\uC2B5\uB2C8\uB2E4."),
      bp("\uC18C\uBD84: ", "\uD55C \uC870\uAC01\uB2F9 \uC57D 20g\uC73C\uB85C \uC18C\uBD84\uB418\uC5B4 \uC788\uC2B5\uB2C8\uB2E4."),
      bp("\uCCA8\uAC00\uBB3C: ", "\uC804\uD600 \uC5C6\uC2B5\uB2C8\uB2E4."),

      h2("4-2. \uC870\uB9AC \uBC29\uBC95"),
      p("\uB0C9\uC7A5 \uD574\uB3D9\uB3C4 \uAC00\uB2A5\uD558\uB098, \uB0C9\uB3D9 \uC0C1\uD0DC \uADF8\uB300\uB85C \uC870\uB9AC\uD558\uBA74 \uC601\uC591\uC18C \uC190\uC2E4\uC774 \uC801\uACE0 \uC9E7\uC740 \uC2DC\uAC04\uC5D0 \uACE8\uACE0\uB8E8 \uC775\uC2B5\uB2C8\uB2E4."),
      p("\uAD73\uC774 \uD574\uB3D9\uD560 \uD544\uC694\uAC00 \uC5C6\uC2B5\uB2C8\uB2E4."),
      p("\uBE44\uB9B0\uB0B4\uAC00 \uAC71\uC815\uB418\uBA74 \uC6B0\uC720\uB098 \uBD84\uC720\uBB3C\uC5D0 \uB2F4\uAC00 \uD574\uB3D9\uD558\uB3C4\uB85D \uC548\uB0B4\uD569\uB2C8\uB2E4."),

      h2("4-3. \uBCF4\uAD00 \uAE30\uAC04"),
      p("\uAC00\uAE09\uC801 \uC870\uB9AC \uB2F9\uC77C\uC5D0 \uC0AC\uC6A9\uD569\uB2C8\uB2E4."),
      p("\uC5EC\uB7EC \uB07C \uBD84\uB7C9\uC744 \uB9CC\uB4E4\uC5C8\uB2E4\uBA74 \uB2F9\uC77C \uC0AC\uC6A9\uBD84 \uC678\uC5D0\uB294 \uBAA8\uB450 \uB0C9\uB3D9\uD558\uB3C4\uB85D \uC548\uB0B4\uD569\uB2C8\uB2E4."),

      h2("4-4. \uC548\uC804 \uBC0F \uAC00\uC2DC \uD074\uB808\uC784 \uC8FC\uC758\uC0AC\uD56D"),
      warn("\uC808\uB300 \"100% \uAC00\uC2DC\uAC00 \uC5C6\uB2E4\" \uB610\uB294 \"\uC548\uC804\uC744 \uBCF4\uC7A5\uD55C\uB2E4\"\uACE0 \uB2F5\uBCC0\uD574\uC11C\uB294 \uC548 \uB429\uB2C8\uB2E4."),
      p("\uC0AC\uC6A9 \uC804 \uC190\uC73C\uB85C \uD655\uC778\uC744 \uBD80\uD0C1\uD574\uC57C \uD569\uB2C8\uB2E4."),

      h2("4-5. \uC774\uC720\uC2DD \uAC00\uC2DC \uBCF4\uC0C1 \uC815\uCC45"),
      warn("\uC774\uC720\uC2DD \uC81C\uD488 \uAC00\uC2DC \uBC1C\uACAC \uC2DC \u2192 \uAD6C\uB9E4 \uAE08\uC561\uC758 200% \uD658\uBD88"),
      p("\uC6D0\uC778 \uD574\uBA85\uBCF4\uB2E4 \uC544\uC774\uC758 \uC548\uC804\uC744 \uCD5C\uC6B0\uC120\uC73C\uB85C \uD655\uC778\uD569\uB2C8\uB2E4."),
      p("\uAC00\uC2DC\uAC00 \uB098\uC628 \uD574\uB2F9 \uD328\uD0A4\uC9C0\uC5D0 \uB300\uD574 \uAD6C\uB9E4 \uAE08\uC561\uC758 200%\uB97C \uD658\uBD88\uD569\uB2C8\uB2E4."),
      p("\uC5EC\uB7EC \uAC1C \uAD6C\uB9E4 \uC2DC \uAC00\uC2DC\uAC00 \uB098\uC628 \uD328\uD0A4\uC9C0\uB9CC 200% \uD658\uBD88\uC774 \uC801\uC6A9\uB418\uBA70, \uB098\uBA38\uC9C0\uB294 \uBC18\uD488 \uC6D0\uD560 \uC2DC \uBCC4\uB3C4 \uC9C4\uD589\uD569\uB2C8\uB2E4."),

      new Paragraph({ children: [new PageBreak()] }),

      // ===== 5. 상품 정보 =====
      h1("5. \uC0C1\uD488 \uC815\uBCF4"),

      h2("5-1. \uC21C\uC0B4 \uC0DD\uC120 \uB77C\uC778 (100g \uB2E8\uC704)"),
      new Table({
        width: { size: 9360, type: WidthType.DXA },
        columnWidths: [1800, 1200, 1200, 1200, 1200, 2760],
        rows: [
          new TableRow({ children: [hCell("\uC0C1\uD488\uBA85", 1800), hCell("\uAC00\uACA9", 1200), hCell("\uCE7C\uB85C\uB9AC", 1200), hCell("\uB2E8\uBC31\uC9C8", 1200), hCell("\uC0C1\uD0DC", 1200), hCell("\uC870\uB9AC\uBC95", 2760)] }),
          new TableRow({ children: [tCell("\uB300\uAD6C\uC21C\uC0B4", 1800), tCell("\u20A92,450", 1200), tCell("86kcal", 1200), tCell("19.5g", 1200), tCell("\uD310\uB9E4\uC911", 1200), tCell("\uC5D0\uC5B4\uD504\uB77C\uC774\uC5B4, \uD32C\uAD6C\uC774, \uC870\uB9BC, \uCC0C", 2760)] }),
          new TableRow({ children: [tCell("\uC5F0\uC5B4\uC21C\uC0B4", 1800), tCell("\u20A93,150", 1200), tCell("142kcal", 1200), tCell("20.6g", 1200), tCell("\uD310\uB9E4\uC911", 1200), tCell("\uD32C\uAD6C\uC774, \uC624\uBE10\uAD6C\uC774, \uB369\uBC25, \uC0D0\uB7EC\uB4DC", 2760)] }),
          new TableRow({ children: [tCell("\uC544\uADC0\uC21C\uC0B4", 1800), tCell("\u20A92,050", 1200), tCell("80kcal", 1200), tCell("17.7g", 1200), tCell("\uD310\uB9E4\uC911", 1200), tCell("\uCC0C, \uD0D5, \uC870\uB9BC, \uD280\uAE40", 2760)] }),
          new TableRow({ children: [tCell("\uAD11\uC5B4\uC21C\uC0B4", 1800), tCell("\u20A92,450", 1200), tCell("103kcal", 1200), tCell("22.4g", 1200), tCell("\uD310\uB9E4\uC911", 1200), tCell("\uD32C\uAD6C\uC774, \uC870\uB9BC, \uD280\uAE40", 2760)] }),
          new TableRow({ children: [tCell("\uB18D\uC5B4\uC21C\uC0B4", 1800), tCell("\u20A92,450", 1200), tCell("97kcal", 1200), tCell("19.3g", 1200), tCell("\uD310\uB9E4\uC911", 1200), tCell("\uD32C\uAD6C\uC774, \uCC0C, \uC18C\uAE08\uAD6C\uC774, \uC218\uBE44\uB4DC", 2760)] }),
          new TableRow({ children: [tCell("\uC0BC\uCE58\uC21C\uC0B4", 1800), tCell("\u20A92,550", 1200), tCell("108kcal", 1200), tCell("19.0g", 1200), tCell("\uD310\uB9E4\uC911", 1200), tCell("\uC18C\uAE08\uAD6C\uC774, \uB41C\uC7A5\uC870\uB9BC, \uC5D0\uC5B4\uD504\uB77C\uC774\uC5B4", 2760)] }),
          new TableRow({ children: [tCell("\uCC38\uB3D4\uC21C\uC0B4", 1800), tCell("\u20A92,750", 1200), tCell("82kcal", 1200), tCell("18.4g", 1200), tCell("\uD310\uB9E4\uC911", 1200), tCell("\uC18C\uAE08\uAD6C\uC774, \uC870\uB9BC, \uCC0C, \uCE74\uB974\uD30C\uCE58\uC624", 2760)] }),
          new TableRow({ children: [tCell("\uD2F8\uB77C\uD53C\uC544\uC21C\uC0B4", 1800), tCell("\u20A92,950", 1200), tCell("126kcal", 1200), tCell("19.3g", 1200), tCell("\uD488\uC808", 1200), tCell("\uD0C0\uCF54, \uCEE4\uB9AC, \uD32C\uAD6C\uC774, \uD280\uAE40", 2760)] }),
          new TableRow({ children: [tCell("\uC624\uC9D5\uC5B4\uC0B4", 1800), tCell("\u20A93,450", 1200), tCell("92kcal", 1200), tCell("15.6g", 1200), tCell("\uD310\uB9E4\uC911", 1200), tCell("\uBCF6\uC74C, \uD280\uAE40, \uAD6C\uC774, \uCC0C\uAC1C", 2760)] }),
          new TableRow({ children: [tCell("\uC0C8\uC6B0\uC0B4", 1800), tCell("\u20A93,850", 1200), tCell("85kcal", 1200), tCell("18.4g", 1200), tCell("\uD310\uB9E4\uC911", 1200), tCell("\uBCF6\uC74C\uBC25, \uD30C\uC2A4\uD0C0, \uD280\uAE40, \uC0D0\uB7EC\uB4DC", 2760)] }),
        ]
      }),

      h2("5-2. \uB80C\uC9C0\uC6A9 \uAC04\uD3B8 \uB77C\uC778 (85g, 5\uAC1C\uD329)"),
      p("\uB354 \uAC04\uD3B8\uD55C \uC0BC\uCE58\uC21C\uC0B4: \u20A916,410/\uD329 | \uB354 \uAC04\uD3B8\uD55C \uC5F0\uC5B4\uC21C\uC0B4: \u20A919,840/\uD329"),
      p("\uC804\uC790\uB80C\uC9C0 2~3\uBD84\uC774\uBA74 \uC644\uC131. \uD574\uB3D9 \uC5C6\uC774 \uBC14\uB85C \uC870\uB9AC \uAC00\uB2A5."),
      p("\uC18C\uAE08\uACFC \uD6C4\uCD94\uAC00 \uAC00\uBBF8\uB41C \uC800\uC5FC \uC81C\uD488\uC785\uB2C8\uB2E4."),

      h2("5-3. \uAD6C\uB9E4 \uBC29\uC2DD"),
      bp("\uC77C\uBC18\uAD6C\uB9E4: ", "100g \uB610\uB294 1kg \uB2E8\uC704 \uC120\uD0DD \uAD6C\uB9E4"),
      bp("\uC815\uAE30\uBC30\uC1A1: ", "1~4\uC8FC \uC8FC\uAE30 \uC120\uD0DD, \uD560\uC778 \uD61C\uD0DD, \uC5B8\uC81C\uB4E0 \uBCC0\uACBD/\uD574\uC9C0 \uAC00\uB2A5 (\uC704\uC57D\uAE08 \uC5C6\uC74C)"),
      bp("\uACE8\uB77C\uB2F4\uAE30: ", "100g \uB2E8\uC704\uB85C \uC790\uC720 \uC870\uD569 (\uC77C\uBC18/\uC815\uAE30\uBC30\uC1A1 \uBAA8\uB450 \uAC00\uB2A5)"),

      p(""),
      new Paragraph({ spacing: { before: 400 }, children: [
        new TextRun({ text: "\uC774 \uBB38\uC11C\uB294 CS \uB2F5\uBCC0 \uC0DD\uC131\uAE30\uC758 \uAE30\uBCF8 \uC9C0\uC2DD\uC73C\uB85C \uC0AC\uC6A9\uB429\uB2C8\uB2E4. \uB0B4\uC6A9 \uCD94\uAC00/\uC218\uC815\uC774 \uD544\uC694\uD558\uBA74 \uC774 \uBB38\uC11C\uB97C \uC5C5\uB370\uC774\uD2B8\uD558\uC138\uC694.", font: "Arial", size: 20, color: "999999", italics: true })
      ]}),
    ]
  }]
});

Packer.toBuffer(doc).then(buffer => {
  fs.writeFileSync("C:/Users/younh/Desktop/claude/meeting-notes/seamonster_cs_guide_v2.docx", buffer);
  console.log("DONE: seamonster_cs_guide_v2.docx");
});
