import '@douyinfe/semi-ui/react19-adapter';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import './Common/StyleSheet.css';

import App from './Views/App';

/**
 * 入口。React 19 需 semi 的 react19-adapter（对齐参考项目）。
 * 本项目无鉴权 / 无枚举端点，故不调 IntiEnums / Authentication。
 * 生产由后端在 :8790 托管（SPA 回退），BrowserRouter 直接可用；开发走 Vite :5173 + 代理。
 */
createRoot(document.getElementById('root')).render(
    <BrowserRouter>
        <App />
    </BrowserRouter>
);
