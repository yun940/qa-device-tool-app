/**
 * 인증/세션 관리 — localStorage 기반 (모바일/웹 둘 다 동일)
 *
 * 세션 데이터:
 *   {
 *     userId, name, role: 'user' | 'admin', kakaoworkEmail, cell, loginAt
 *   }
 */
(function () {
    'use strict';

    const STORAGE_KEY = 'qa-device-tool.session';

    function loadSession() {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            return raw ? JSON.parse(raw) : null;
        } catch (e) {
            return null;
        }
    }

    function saveSession(user) {
        const session = {
            userId: user.userId,
            name: user.name,
            role: user.role || 'user',
            kakaoworkEmail: user.kakaoworkEmail || '',
            cell: user.cell || '',
            loginAt: Date.now()
        };
        localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
        return session;
    }

    function clearSession() {
        localStorage.removeItem(STORAGE_KEY);
    }

    function isLoggedIn() {
        return !!loadSession();
    }

    function isAdmin() {
        const s = loadSession();
        return !!(s && s.role === 'admin');
    }

    /**
     * 서버 로그인 — GAS의 action:'login' 호출
     *   성공 시 세션 저장 후 user 반환
     *   실패 시 throw Error(message)
     */
    async function login(userId) {
        if (!userId) throw new Error('아이디를 입력해주세요.');
        if (!window.CONFIG || !window.CONFIG.API_URL) {
            throw new Error('API_URL이 설정되지 않았습니다. js/config.js를 확인하세요.');
        }
        const res = await fetch(window.CONFIG.API_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain;charset=utf-8' },
            body: JSON.stringify({ action: 'login', userId: userId })
        });
        const data = await res.json();
        if (!data.success) throw new Error(data.message || '로그인 실패');
        return saveSession(data.user);
    }

    function logout() {
        clearSession();
    }

    window.QaAuth = {
        loadSession, saveSession, clearSession,
        isLoggedIn, isAdmin, login, logout
    };
})();
