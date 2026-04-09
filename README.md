# 🎮 Heeph Client — Custom Minecraft Launcher

Launcher fiel ao design do Heeph Client com tema underwater dark.

---

## 🚀 Como usar

```bash
# Instalar dependências
npm install

# Rodar em dev
npm start

# Build Windows
npm run build:win

# Build macOS
npm run build:mac

# Build Linux
npm run build:linux
```

---

## ⚙️ Configuração

1. Clique em **MENU → Configurações**
2. Defina seu **nome de usuário**
3. Selecione sua versão no dropdown do banner
4. Ajuste a **RAM** no slider
5. Clique em **START GAME**

### Versão Modrinth (com mods)
- Instale o [Modrinth App](https://modrinth.com/app)
- No menu **Configurações**, coloque o ID do perfil
- Use **MENU → Modrinth App** para abrir

---

## 📁 Estrutura

```
src/
  main.js      ← Electron main process
  preload.js   ← API bridge (contextBridge)
  index.html   ← Interface
  style.css    ← Estilos
  renderer.js  ← Lógica da UI
  assets/      ← Ícones (icon.ico, icon.icns, icon.png)
```

## 🎨 Personalizar

- **Cores**: edite as variáveis `--green`, `--outer-bg` etc. em `style.css`
- **Logo**: substitua o SVG `.logo-svg` em `index.html`
- **Background**: o canvas underwater está em `renderer.js` — função `initCanvas()`
- **Nome**: altere `"productName"` e `"name"` no `package.json`

## ✅ Requisitos

- Node.js 18+
- Java 17+ (para rodar o Minecraft)
- Minecraft instalado via launcher oficial (ao menos uma vez)
- Modrinth App (opcional, para mods)
