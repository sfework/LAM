import Projects from '../Views/Projects';
import Models from '../Views/Models';
import Settings from '../Views/Settings';
import DenoiseRules from '../Views/DenoiseRules';
import Prompts from '../Views/Prompts';
import Agents from '../Views/Agents';
import Skills from '../Views/Skills';
import Knowledges from '../Views/Knowledges';
import DbBackup from '../Views/DbBackup';
import Logs from '../Views/Logs';
import CodeGraph from '../Views/CodeGraph';
import Memories from '../Views/Memories';
import Tools from '../Views/Tools';

/**
 * 菜单 = 路由 = 面包屑的单一数据源（参考项目约定）。
 * itemKey 稳定唯一；url 对应 react-router 路径；element 为页面组件。
 * 本项目无鉴权，故不做 permissions 过滤。
 */
const MenuItems = [
    { itemKey: '100001', text: '项目', url: '/', element: <Projects /> },
    { itemKey: '100002', text: '提示词', url: '/Prompts', element: <Prompts /> },
    { itemKey: '100003', text: 'Agents', url: '/Agents', element: <Agents /> },
    { itemKey: '100004', text: '技能', url: '/Skills', element: <Skills /> },
    { itemKey: '100005', text: '知识库', url: '/Knowledges', element: <Knowledges /> },
    { itemKey: '100006', text: 'CodeGraph', url: '/CodeGraph', element: <CodeGraph /> },
    { itemKey: '100007', text: '记忆', url: '/Memories', element: <Memories /> },
    { itemKey: '100008', text: '模型', url: '/Models', element: <Models /> },
    { itemKey: '100009', text: '设置', url: '/Settings', element: <Settings /> },
    { itemKey: '100010', text: '除噪规则', url: '/DenoiseRules', element: <DenoiseRules /> },
    { itemKey: '100011', text: 'DB 备份', url: '/DbBackup', element: <DbBackup /> },
    { itemKey: '100012', text: '日志', url: '/Logs', element: <Logs /> },
    { itemKey: '100013', text: '工具库', url: '/Tools', element: <Tools /> },
];

export { MenuItems };
